import { describe, expect, it } from 'vitest';
import { parseWebviewMessage } from './bridge.js';

describe('parseWebviewMessage', () => {
  it('accepts webview-ready', () => {
    expect(parseWebviewMessage({ type: 'webview-ready' })).toEqual({ type: 'webview-ready' });
  });

  it('accepts request-switch-gezel and request-switch-folder', () => {
    expect(parseWebviewMessage({ type: 'request-switch-gezel' })).toEqual({
      type: 'request-switch-gezel',
    });
    expect(parseWebviewMessage({ type: 'request-switch-folder' })).toEqual({
      type: 'request-switch-folder',
    });
  });

  it('accepts open-external with url', () => {
    expect(parseWebviewMessage({ type: 'open-external', url: 'https://example.com' })).toEqual({
      type: 'open-external',
      url: 'https://example.com',
    });
  });

  it('rejects open-external without url', () => {
    expect(parseWebviewMessage({ type: 'open-external' })).toBeNull();
    expect(parseWebviewMessage({ type: 'open-external', url: 42 })).toBeNull();
  });

  it('parses open-file with optional line', () => {
    expect(parseWebviewMessage({ type: 'open-file', path: '/x/y' })).toEqual({
      type: 'open-file',
      path: '/x/y',
      line: undefined,
    });
    expect(parseWebviewMessage({ type: 'open-file', path: '/x/y', line: 12 })).toEqual({
      type: 'open-file',
      path: '/x/y',
      line: 12,
    });
  });

  it('accepts log with valid level', () => {
    expect(parseWebviewMessage({ type: 'log', level: 'info', message: 'hi' })).toEqual({
      type: 'log',
      level: 'info',
      message: 'hi',
    });
  });

  it('rejects log with invalid level', () => {
    expect(parseWebviewMessage({ type: 'log', level: 'panic', message: 'hi' })).toBeNull();
  });

  it('rejects unknown types and malformed input', () => {
    expect(parseWebviewMessage({ type: 'nope' })).toBeNull();
    expect(parseWebviewMessage(null)).toBeNull();
    expect(parseWebviewMessage(undefined)).toBeNull();
    expect(parseWebviewMessage('webview-ready')).toBeNull();
    expect(parseWebviewMessage({})).toBeNull();
  });

  it('accepts fetch-request with string body, normalizes header keys to lowercase', () => {
    expect(
      parseWebviewMessage({
        type: 'fetch-request',
        id: 'req-1',
        url: '/api/projects/foo',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: '{"hello":"world"}',
      }),
    ).toEqual({
      type: 'fetch-request',
      id: 'req-1',
      url: '/api/projects/foo',
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: '{"hello":"world"}',
    });
  });

  it('accepts fetch-request with null body and drops non-string header values', () => {
    expect(
      parseWebviewMessage({
        type: 'fetch-request',
        id: 'req-2',
        url: '/api/health',
        method: 'GET',
        headers: { Authorization: 'Bearer abc', 'x-bad': 42 },
        body: null,
      }),
    ).toEqual({
      type: 'fetch-request',
      id: 'req-2',
      url: '/api/health',
      method: 'GET',
      headers: { authorization: 'Bearer abc' },
      body: null,
    });
  });

  it('rejects fetch-request with missing id/url/method/headers', () => {
    const base = {
      type: 'fetch-request',
      id: 'r',
      url: '/x',
      method: 'GET',
      headers: {},
      body: null,
    };
    expect(parseWebviewMessage({ ...base, id: undefined })).toBeNull();
    expect(parseWebviewMessage({ ...base, url: 42 })).toBeNull();
    expect(parseWebviewMessage({ ...base, method: null })).toBeNull();
    expect(parseWebviewMessage({ ...base, headers: 'not-an-object' })).toBeNull();
    expect(parseWebviewMessage({ ...base, body: 42 })).toBeNull();
  });

  it('accepts fetch-abort with id', () => {
    expect(parseWebviewMessage({ type: 'fetch-abort', id: 'req-3' })).toEqual({
      type: 'fetch-abort',
      id: 'req-3',
    });
  });

  it('rejects fetch-abort without id', () => {
    expect(parseWebviewMessage({ type: 'fetch-abort' })).toBeNull();
    expect(parseWebviewMessage({ type: 'fetch-abort', id: 7 })).toBeNull();
  });
});
