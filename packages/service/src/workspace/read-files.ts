import { constants } from 'node:fs';
import { type FileHandle, open, realpath } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import {
  type ReadWorkspaceFilesRequest,
  type ReadWorkspaceFilesResponse,
  WORKSPACE_READ_DEADLINE_MS,
  WORKSPACE_READ_MAX_BATCH_LINES,
  WORKSPACE_READ_MAX_BATCH_RESULT_BYTES,
  WORKSPACE_READ_MAX_BATCH_SCAN_BYTES,
  WORKSPACE_READ_MAX_RANGE_LINES,
  WORKSPACE_READ_MAX_RESULT_BYTES,
  WORKSPACE_READ_MAX_SCAN_BYTES,
  type WorkspaceReadFileError,
  type WorkspaceReadFileRequest,
  type WorkspaceReadFileResult,
  type WorkspaceReadFileSuccess,
} from '@bendyline/gezel';
import { PathSafetyError, resolveInside } from '../fs/safe-paths.js';

const READ_CHUNK_BYTES = 64 * 1024;
const ERROR_PREVIEW_CHARS = 500;

export interface ReadWorkspaceFilesOptions extends ReadWorkspaceFilesRequest {
  workspaceDir: string;
}

interface ItemLimits {
  outputBytes: number;
  returnedLines: number;
  scanBytes: number;
  deadlineAt: number;
}

/**
 * Ordered, bounded workspace reads for the MCP file tools. One bad path is an
 * item-level error rather than a failed batch, so a model still receives the
 * independent files that were valid. Output/line/scan capacity is divided
 * fairly among remaining items; unused capacity rolls forward.
 */
export async function readWorkspaceFiles(
  opts: ReadWorkspaceFilesOptions,
): Promise<ReadWorkspaceFilesResponse> {
  const results: WorkspaceReadFileResult[] = [];
  const deadlineAt = Date.now() + WORKSPACE_READ_DEADLINE_MS;
  let remainingOutputBytes = WORKSPACE_READ_MAX_BATCH_RESULT_BYTES;
  let remainingLines = WORKSPACE_READ_MAX_BATCH_LINES;
  let remainingScanBytes = WORKSPACE_READ_MAX_BATCH_SCAN_BYTES;

  for (let index = 0; index < opts.files.length; index += 1) {
    const request = opts.files[index]!;
    const remainingItems = opts.files.length - index;
    if (Date.now() >= deadlineAt) {
      results.push(readError(request.path, 'deadline', 'workspace read deadline reached'));
      continue;
    }
    if (remainingOutputBytes <= 0 || remainingLines <= 0 || remainingScanBytes <= 0) {
      results.push(
        readError(
          request.path,
          'aggregate-limit',
          'batch read budget reached; retry this file in a new call',
        ),
      );
      continue;
    }

    const limits: ItemLimits = {
      outputBytes: Math.min(
        WORKSPACE_READ_MAX_RESULT_BYTES,
        Math.max(1, Math.floor(remainingOutputBytes / remainingItems)),
      ),
      returnedLines: Math.min(
        WORKSPACE_READ_MAX_RANGE_LINES,
        Math.max(1, Math.floor(remainingLines / remainingItems)),
      ),
      scanBytes: Math.min(
        WORKSPACE_READ_MAX_SCAN_BYTES,
        Math.max(1, Math.floor(remainingScanBytes / remainingItems)),
      ),
      deadlineAt,
    };
    const result = await readOneWorkspaceFile(opts.workspaceDir, request, limits);
    results.push(result);
    const scannedBytes = result.scannedBytes ?? 0;
    remainingScanBytes = Math.max(0, remainingScanBytes - scannedBytes);
    if (result.status === 'ok') {
      remainingOutputBytes = Math.max(0, remainingOutputBytes - result.bytesReturned);
      remainingLines = Math.max(0, remainingLines - result.linesReturned);
    }
  }

  return {
    results,
    truncated: results.some(
      (result) => result.status === 'error' || (result.status === 'ok' && result.truncated),
    ),
    totalBytesReturned: WORKSPACE_READ_MAX_BATCH_RESULT_BYTES - remainingOutputBytes,
    totalScannedBytes: WORKSPACE_READ_MAX_BATCH_SCAN_BYTES - remainingScanBytes,
  };
}

async function readOneWorkspaceFile(
  workspaceDir: string,
  request: WorkspaceReadFileRequest,
  limits: ItemLimits,
): Promise<WorkspaceReadFileResult> {
  let resolved: string;
  try {
    resolved = await resolveInside(workspaceDir, request.path);
  } catch (error) {
    if (error instanceof PathSafetyError) {
      return readError(request.path, 'path-safety', error.message);
    }
    return readError(request.path, 'read-failed', errorMessage(error));
  }

  const normalizedPath = relative(workspaceDir, resolved).split(sep).join('/');
  let physicalPath: string;
  try {
    physicalPath = await realpath(resolved);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return readError(normalizedPath || request.path, 'path-not-found', 'file not found');
    }
    return readError(normalizedPath || request.path, 'read-failed', errorMessage(error));
  }

  let handle: FileHandle;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    // `physicalPath` is already the contained real target, so O_NOFOLLOW
    // closes a final-component swap without blocking legitimate inward
    // symlinks from the model-named path.
    handle = await open(physicalPath, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return readError(normalizedPath || request.path, 'path-not-found', 'file not found');
    }
    return readError(normalizedPath || request.path, 'read-failed', errorMessage(error));
  }

  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      return readError(normalizedPath || request.path, 'not-file', 'path is not a regular file');
    }
    return await readOpenedTextFile(
      handle,
      normalizedPath || request.path,
      Number(fileStat.size),
      request,
      limits,
    );
  } catch (error) {
    return readError(normalizedPath || request.path, 'read-failed', errorMessage(error));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readOpenedTextFile(
  handle: FileHandle,
  path: string,
  fileBytes: number,
  request: WorkspaceReadFileRequest,
  limits: ItemLimits,
): Promise<WorkspaceReadFileResult> {
  const startLine = request.startLine ?? 1;
  const requestedEndLine =
    request.endLine ?? Math.min(10_000_000, startLine + WORKSPACE_READ_MAX_RANGE_LINES - 1);
  const effectiveEndLine = Math.min(requestedEndLine, startLine + limits.returnedLines - 1);
  const fairnessLineLimited = effectiveEndLine < requestedEndLine;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const returnedLines: string[] = [];
  let currentLineParts: string[] = [];
  let currentLineBytes = 0;
  let currentLine = 1;
  let completedLines = 0;
  let bytesReturned = 0;
  let scannedBytes = 0;
  let position = 0;
  let lastByte: number | undefined;
  let stopped = false;
  let eof = fileBytes === 0;
  let hasMore = false;
  let nextStartLine: number | undefined;
  let truncationReason: WorkspaceReadFileSuccess['truncationReason'];
  let fatalError: WorkspaceReadFileError | undefined;
  let rangeEndedAtNewline = false;

  // The line-processing callbacks can set `fatalError`. Read it through a
  // function so TypeScript does not incorrectly preserve an earlier
  // `undefined` narrowing across those callback calls.
  const currentFatalError = (): WorkspaceReadFileError | undefined => fatalError;

  const captureCurrentLine = () => currentLine >= startLine && currentLine <= effectiveEndLine;

  const stopAfterCompletedRange = (): void => {
    hasMore = true;
    nextStartLine = effectiveEndLine + 1;
    if (fairnessLineLimited || request.endLine === undefined) {
      truncationReason = 'line-limit';
    }
    stopped = true;
  };

  const appendSegment = (segment: string): void => {
    if (!captureCurrentLine() || segment.length === 0 || fatalError) return;
    currentLineBytes += Buffer.byteLength(segment);
    if (currentLineBytes > limits.outputBytes) {
      const preview = utf8Prefix([...currentLineParts, segment].join(''), ERROR_PREVIEW_CHARS);
      fatalError = readError(
        path,
        'line-too-long',
        `line ${currentLine} exceeds this read's ${limits.outputBytes}-byte output budget; use grep_files to narrow it${preview ? ` (preview: ${JSON.stringify(preview)})` : ''}`,
        scannedBytes,
      );
      return;
    }
    currentLineParts.push(segment);
  };

  const finishCurrentLine = (): void => {
    const lineNumber = currentLine;
    if (captureCurrentLine() && !fatalError) {
      let line = currentLineParts.join('');
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const lineBytes = Buffer.byteLength(line);
      const separatorBytes = returnedLines.length > 0 ? 1 : 0;
      if (bytesReturned + separatorBytes + lineBytes > limits.outputBytes) {
        if (returnedLines.length === 0) {
          fatalError = readError(
            path,
            'line-too-long',
            `line ${lineNumber} exceeds this read's ${limits.outputBytes}-byte output budget; use grep_files to narrow it`,
            scannedBytes,
          );
        } else {
          stopped = true;
          hasMore = true;
          nextStartLine = lineNumber;
          truncationReason = 'output-limit';
        }
      } else {
        returnedLines.push(line);
        bytesReturned += separatorBytes + lineBytes;
      }
    }

    completedLines = lineNumber;
    currentLine += 1;
    currentLineParts = [];
    currentLineBytes = 0;
    if (!fatalError && !stopped && lineNumber === effectiveEndLine) {
      rangeEndedAtNewline = true;
    }
  };

  const processDecoded = (decoded: string): void => {
    if (!decoded || stopped || fatalError) return;
    if (rangeEndedAtNewline) {
      stopAfterCompletedRange();
      return;
    }
    let cursor = 0;
    while (cursor <= decoded.length && !stopped && !fatalError) {
      const newline = decoded.indexOf('\n', cursor);
      if (newline < 0) {
        appendSegment(decoded.slice(cursor));
        break;
      }
      appendSegment(decoded.slice(cursor, newline));
      finishCurrentLine();
      cursor = newline + 1;
      if (rangeEndedAtNewline && cursor < decoded.length) {
        stopAfterCompletedRange();
      }
    }
  };

  while (!stopped && !fatalError && position < fileBytes) {
    if (Date.now() >= limits.deadlineAt) {
      return readError(path, 'deadline', 'workspace read deadline reached', scannedBytes);
    }
    if (scannedBytes >= limits.scanBytes) {
      return readError(
        path,
        'scan-limit',
        `requested range was not reached within ${limits.scanBytes} scanned bytes; narrow the range or use grep_files`,
        scannedBytes,
      );
    }
    const bytesToRead = Math.min(
      chunk.length,
      fileBytes - position,
      limits.scanBytes - scannedBytes,
    );
    const { bytesRead } = await handle.read(chunk, 0, bytesToRead, position);
    if (bytesRead === 0) {
      eof = true;
      break;
    }
    const bytes = chunk.subarray(0, bytesRead);
    position += bytesRead;
    scannedBytes += bytesRead;
    lastByte = bytes[bytes.length - 1];
    if (
      position === bytesRead &&
      bytes.length >= 2 &&
      ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
    ) {
      return readError(
        path,
        'unsupported-encoding',
        'UTF-16 text is not supported; convert the file to UTF-8 before reading it',
        scannedBytes,
      );
    }
    if (bytes.includes(0)) {
      return readError(
        path,
        'binary-file',
        'file contains NUL bytes; use a media/document-specific read tool',
        scannedBytes,
      );
    }
    try {
      processDecoded(decoder.decode(bytes, { stream: true }));
    } catch {
      return readError(
        path,
        'unsupported-encoding',
        'file is not valid UTF-8 text; use a media/document-specific read tool',
        scannedBytes,
      );
    }
    // When the requested last line ends exactly at the end of this decoded
    // chunk, `processDecoded` has no following character with which to prove
    // that more content exists. The fstat size already gives us that proof;
    // stop here instead of reading and charging a whole extra chunk merely to
    // discover the next byte.
    if (!stopped && rangeEndedAtNewline && position < fileBytes) {
      stopAfterCompletedRange();
    }
  }

  const decodeError = currentFatalError();
  if (decodeError) return { ...decodeError, scannedBytes };
  if (stopped) {
    const endLine = returnedLines.length > 0 ? startLine + returnedLines.length - 1 : 0;
    return successResult({
      path,
      content: returnedLines.join('\n'),
      startLine,
      endLine,
      bytesReturned,
      totalBytes: fileBytes,
      scannedBytes,
      eof: false,
      hasMore,
      nextStartLine,
      truncationReason,
      completeFile: false,
    });
  }

  if (position >= fileBytes) eof = true;
  if (!eof) {
    return readError(
      path,
      'scan-limit',
      `requested range was not reached within ${limits.scanBytes} scanned bytes; narrow the range or use grep_files`,
      scannedBytes,
    );
  }

  try {
    processDecoded(decoder.decode());
  } catch {
    return readError(
      path,
      'unsupported-encoding',
      'file is not valid UTF-8 text; use a media/document-specific read tool',
      scannedBytes,
    );
  }
  const finalLineError = currentFatalError();
  if (finalLineError) return { ...finalLineError, scannedBytes };

  // A trailing newline terminates the last logical line; it does not create a
  // phantom extra line. Any other non-empty file has one final unterminated
  // logical line to commit at EOF.
  if (fileBytes > 0 && lastByte !== 0x0a && !rangeEndedAtNewline) finishCurrentLine();
  const unterminatedLineError = currentFatalError();
  if (unterminatedLineError) return { ...unterminatedLineError, scannedBytes };

  const totalLines = completedLines;
  if (startLine > totalLines && !(fileBytes === 0 && startLine === 1)) {
    return readError(
      path,
      'range-out-of-bounds',
      `startLine ${startLine} is past EOF (${totalLines} total lines)`,
      scannedBytes,
    );
  }

  const endLine = returnedLines.length > 0 ? startLine + returnedLines.length - 1 : 0;
  const fairnessTruncated = fairnessLineLimited && effectiveEndLine < totalLines;
  const implicitLineLimited = request.endLine === undefined && endLine < totalLines;
  const truncated = fairnessTruncated || implicitLineLimited;
  const completeFile = startLine === 1 && endLine === totalLines && !truncated;
  let content = returnedLines.join('\n');
  if (completeFile && lastByte === 0x0a) {
    if (bytesReturned + 1 <= limits.outputBytes) {
      content += '\n';
      bytesReturned += 1;
    } else {
      return readError(
        path,
        'line-too-long',
        'the complete file does not fit this read output budget; request a smaller line range',
        scannedBytes,
      );
    }
  }

  return successResult({
    path,
    content,
    startLine,
    endLine,
    bytesReturned,
    totalLines,
    totalBytes: fileBytes,
    scannedBytes,
    eof: true,
    hasMore: false,
    completeFile,
    ...(truncated ? { truncationReason: 'line-limit' as const } : {}),
  });
}

function successResult(
  value: Omit<WorkspaceReadFileSuccess, 'status' | 'linesReturned' | 'truncated'>,
): WorkspaceReadFileSuccess {
  const linesReturned = value.endLine >= value.startLine ? value.endLine - value.startLine + 1 : 0;
  return {
    status: 'ok',
    ...value,
    linesReturned,
    truncated: value.truncationReason !== undefined,
  };
}

function utf8Prefix(value: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  return Array.from(value).slice(0, maxChars).join('');
}

function readError(
  path: string,
  code: WorkspaceReadFileError['code'],
  error: string,
  scannedBytes?: number,
): WorkspaceReadFileError {
  return {
    status: 'error',
    path,
    code,
    error: error.slice(0, 1000),
    ...(scannedBytes !== undefined ? { scannedBytes } : {}),
  };
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
