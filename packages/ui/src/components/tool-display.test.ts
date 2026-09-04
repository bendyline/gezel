import { describe, expect, it } from 'vitest';
import {
  TOOL_DISPLAY_NAMES,
  TOOL_ERROR_SUMMARY_MAX,
  isKnownTool,
  toolActivityPhrase,
  toolArgsDisplaySummary,
  toolDisplayName,
  toolErrorSummary,
} from './tool-display.js';

describe('toolDisplayName', () => {
  it('shows a concrete Gezel MCP tool name across CLI wire formats', () => {
    expect(toolDisplayName('advance_task_step')).toBe('Advance task step');
    expect(toolDisplayName('mcp__gezel__advance_task_step')).toBe('Advance task step');
    expect(toolDisplayName('gezel-advance_task_step')).toBe('Advance task step');
    expect(toolDisplayName('mcp__gezel__add_task_step')).toBe('Add task step');
  });

  it('names the act rather than the function for jargon-shaped slugs', () => {
    expect(toolDisplayName('grep_files')).toBe('Search across files');
    expect(toolDisplayName('find_files')).toBe('Find files by name');
    expect(toolDisplayName('derive_file')).toBe('Compute a data file');
    expect(toolDisplayName('fetch_url')).toBe('Open a web page');
  });

  it('labels a CLI provider built-in the same as its Gezel equivalent', () => {
    expect(toolDisplayName('Grep')).toBe(toolDisplayName('grep_files'));
    expect(toolDisplayName('Read')).toBe(toolDisplayName('read_file'));
    expect(toolDisplayName('WebSearch')).toBe(toolDisplayName('web_search'));
  });

  it('generates both halves of every role delegation pair', () => {
    expect(toolDisplayName('delegate_developer')).toBe('Hand work to the developer');
    expect(toolDisplayName('consult_developer')).toBe('Ask the developer');
    expect(toolDisplayName('consult_meester')).toBe('Ask the Meester');
  });

  // The bug this file exists to prevent: an unmapped tool used to render as
  // a bare lowercase slug ("grep files") beside mapped ones ("Read file").
  it('capitalizes unknown concrete tools instead of showing a bare slug', () => {
    expect(toolDisplayName('future_gezel_tool')).toBe('Future gezel tool');
    expect(toolDisplayName('gezel-future_gezel_tool')).toBe('Future gezel tool');
    expect(toolDisplayName('mcp__docblocks__convert_document')).toBe('Convert document');
  });

  it('leaves proper nouns inside a label alone', () => {
    expect(toolDisplayName('run_nodejs_script')).toBe('Run Node.js script');
    expect(toolDisplayName('run_npx')).toBe('Run an npx command');
    expect(toolDisplayName('wikipedia_search')).toBe('Search Wikipedia');
  });

  it('starts every mapped label with a capital', () => {
    const lowercase = Object.entries(TOOL_DISPLAY_NAMES).filter(
      ([, label]) => label[0] !== label[0]!.toUpperCase(),
    );
    expect(lowercase).toEqual([]);
  });
});

describe('toolArgsDisplaySummary', () => {
  it('removes JSON value wrappers without exposing escaped inner quotes', () => {
    expect(
      toolArgsDisplaySummary(
        'question: "\\"dsaav\\" — What now?", prompt: "What should I work on?", choices: [4 items]',
      ),
    ).toBe('question: "dsaav" — What now?, prompt: What should I work on?, choices: [4 items]');
  });

  it('leaves malformed quoted fragments unchanged', () => {
    expect(toolArgsDisplaySummary('question: "unfinished \\x value"')).toBe(
      'question: "unfinished \\x value"',
    );
  });
});

describe('toolErrorSummary', () => {
  // The wild-caught case: a completion gate rejected a craftbook step and
  // the only trace in the thread was a red ✗ next to "Advance task step".
  const GATE_REJECTION = [
    '[gate_rejected] Step "scan" on squisq/5 was NOT completed — its gate rejected the work (attempt 1/6):',
    '',
    '- pr-review-coverage.json: reviewed 25 path(s), but the connector corpus contains 68.',
    ' Address these specifically, then call `advance_task_step` again.',
    'Retryable: true',
  ].join('\n');

  it('drops the machine code prefix and the retryable flag', () => {
    const summary = toolErrorSummary(GATE_REJECTION);
    expect(summary).not.toContain('[gate_rejected]');
    expect(summary).not.toContain('Retryable:');
    expect(summary).toContain('its gate rejected the work (attempt 1/6)');
    expect(summary).toContain('reviewed 25 path(s), but the connector corpus contains 68');
  });

  it("keeps the gate's line breaks so listed criteria stay readable", () => {
    expect(toolErrorSummary(GATE_REJECTION)).toContain('\n- pr-review-coverage.json');
  });

  it('bounds a long reason and marks the cut', () => {
    const summary = toolErrorSummary(`Rejected because ${'word '.repeat(200)}`);
    expect(summary.length).toBeLessThanOrEqual(TOOL_ERROR_SUMMARY_MAX + 1);
    expect(summary.endsWith('…')).toBe(true);
    // Cut on a word boundary, not mid-token.
    expect(summary).not.toMatch(/wor…$/);
  });

  it('cuts mid-token rather than losing most of the budget to one long word', () => {
    const summary = toolErrorSummary(`x ${'y'.repeat(400)}`);
    expect(summary.length).toBe(TOOL_ERROR_SUMMARY_MAX + 1);
  });

  it('leaves a short error untouched', () => {
    expect(toolErrorSummary('No such file: report.md')).toBe('No such file: report.md');
  });
});

describe('toolActivityPhrase', () => {
  it('reports the act as something happening rather than an instruction', () => {
    expect(toolActivityPhrase('grep_files')).toBe('Searching across files');
    expect(toolActivityPhrase('search_memory')).toBe('Searching memory');
    expect(toolActivityPhrase('advance_task_step')).toBe('Advancing task step');
    expect(toolActivityPhrase('mcp__gezel__write_artifact')).toBe('Writing artifact');
  });

  // Four spelling rules, one representative each. The sweep below is what
  // actually guards the vocabulary; these name the rules for the next reader.
  it('applies each -ing spelling rule', () => {
    expect(toolActivityPhrase('create_gezel')).toBe('Creating gezel'); // silent -e drops
    expect(toolActivityPhrase('run_git')).toBe('Running a git command'); // CVC doubles
    expect(toolActivityPhrase('replace_in_file')).toBe('Editing file'); // two vowels, no double
    expect(toolActivityPhrase('verify_outcome')).toBe('Verifying an outcome'); // -y stands
  });

  /**
   * Every present participle the shipped vocabulary produces, frozen.
   *
   * Rule-based conjugation is only safe while every curated label opens
   * with a bare-infinitive verb — a label starting with a noun would yield
   * "Tooling call" and read as nonsense. No assertion can tell a real verb
   * from a plausible-looking noun, so the guard is this list: adding a
   * label whose first word is new fails here, and a person reads the
   * participle once before it ships.
   */
  const PARTICIPLES = [
    'Activating',
    'Adding',
    'Advancing',
    'Answering',
    'Applying',
    'Asking',
    'Assigning',
    'Browsing',
    'Checking',
    'Choosing',
    'Clicking',
    'Closing',
    'Commenting',
    'Comparing',
    'Computing',
    'Copying',
    'Creating',
    'Deleting',
    'Describing',
    'Drafting',
    'Editing',
    'Exporting',
    'Extracting',
    'Fetching',
    'Filling',
    'Finding',
    'Generating',
    'Going',
    'Handing',
    'Hovering',
    'Importing',
    'Inserting',
    'Installing',
    'Listing',
    'Loading',
    'Looking',
    'Mapping',
    'Messaging',
    'Opening',
    'Outlining',
    'Pressing',
    'Publishing',
    'Queuing',
    'Reading',
    'Removing',
    'Renaming',
    'Rendering',
    'Reordering',
    'Replacing',
    'Resizing',
    'Reviewing',
    'Running',
    'Saving',
    'Searching',
    'Sending',
    'Setting',
    'Splitting',
    'Starting',
    'Suggesting',
    'Summarizing',
    'Switching',
    'Taking',
    'Tracing',
    'Transcribing',
    'Turning',
    'Typing',
    'Updating',
    'Uploading',
    'Using',
    'Verifying',
    'Viewing',
    'Waiting',
    'Writing',
  ];

  it('conjugates every curated label to a known present participle', () => {
    const seen = new Set<string>();
    for (const slug of Object.keys(TOOL_DISPLAY_NAMES)) {
      seen.add(toolActivityPhrase(slug).split(' ')[0] ?? '');
    }
    expect([...seen].sort()).toEqual(PARTICIPLES);
  });

  it('leaves an unmapped tool as its label, with no guessed verb', () => {
    expect(toolActivityPhrase('some_new_tool')).toBe('Some new tool');
    expect(toolActivityPhrase('browser_frobnicate')).toBe('Browser: frobnicate');
  });
});

describe('isKnownTool', () => {
  it('sees through the wire prefixes a provider adds', () => {
    expect(isKnownTool('grep_files')).toBe(true);
    expect(isKnownTool('mcp__gezel__grep_files')).toBe(true);
    expect(isKnownTool('gezel-grep_files')).toBe(true);
    expect(isKnownTool('grep_fi')).toBe(false);
  });
});
