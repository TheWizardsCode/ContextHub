import { describe, it, expect } from 'vitest';
import { escapeShellArg, quoteShellValue } from '../src/shell-escape.js';

describe('escapeShellArg (POSIX)', () => {
  it('wraps a plain string in single quotes', () => {
    const result = escapeShellArg('hello');
    expect(result).toBe("'hello'");
  });

  it('escapes single quotes within the string', () => {
    const result = escapeShellArg("it's");
    expect(result).toBe("'it'\\''s'");
  });

  it('handles backticks', () => {
    const result = escapeShellArg('`rm -rf /`');
    expect(result).toBe("'`rm -rf /`'");
  });

  it('handles dollar-parens command substitution', () => {
    const result = escapeShellArg('$(whoami)');
    expect(result).toBe("'$(whoami)'");
  });

  it('handles semicolons', () => {
    const result = escapeShellArg('hello; rm -rf /');
    expect(result).toBe("'hello; rm -rf /'");
  });

  it('handles pipes', () => {
    const result = escapeShellArg('ls | grep foo');
    expect(result).toBe("'ls | grep foo'");
  });

  it('handles double quotes', () => {
    const result = escapeShellArg('say "hello"');
    expect(result).toBe("'say \"hello\"'");
  });

  it('handles empty string', () => {
    const result = escapeShellArg('');
    expect(result).toBe("''");
  });

  it('handles newlines inside string', () => {
    const result = escapeShellArg('line1\nline2');
    expect(result).toBe("'line1\nline2'");
  });

  it('handles mixed metacharacters', () => {
    const malicious = "foo'; rm -rf /; echo 'bar";
    const result = escapeShellArg(malicious);
    expect(result).toBe("'foo'\\''; rm -rf /; echo '\\''bar'");
  });
});

describe('escapeShellArg (Windows)', () => {
  it('wraps a plain string in double quotes', () => {
    const result = escapeShellArg('hello', 'win32');
    expect(result).toBe('"hello"');
  });

  it('escapes double quotes within the string', () => {
    const result = escapeShellArg('say "hello"', 'win32');
    expect(result).toBe('"say \\"hello\\""');
  });

  it('handles backticks on Windows', () => {
    const result = escapeShellArg('`rm -rf /`', 'win32');
    expect(result).toBe('"`rm -rf /`"');
  });

  it('handles empty string on Windows', () => {
    const result = escapeShellArg('', 'win32');
    expect(result).toBe('""');
  });
});

describe('quoteShellValue', () => {
  it('wraps a plain string in single quotes', () => {
    const result = quoteShellValue('hello');
    expect(result).toBe("'hello'");
  });

  it('escapes single quotes within the string', () => {
    const result = quoteShellValue("it's");
    expect(result).toBe("'it'\\''s'");
  });

  it('handles backticks', () => {
    const result = quoteShellValue('`rm -rf /`');
    expect(result).toBe("'`rm -rf /`'");
  });

  it('handles dollar-parens', () => {
    const result = quoteShellValue('$(whoami)');
    expect(result).toBe("'$(whoami)'");
  });

  it('handles semicolons', () => {
    const result = quoteShellValue('hello; rm -rf /');
    expect(result).toBe("'hello; rm -rf /'");
  });

  it('handles pipes', () => {
    const result = quoteShellValue('ls | grep foo');
    expect(result).toBe("'ls | grep foo'");
  });

  it('handles double quotes', () => {
    const result = quoteShellValue('say "hello"');
    expect(result).toBe("'say \"hello\"'");
  });

  it('handles empty string', () => {
    const result = quoteShellValue('');
    expect(result).toBe("''");
  });

  it('handles mixed metacharacters', () => {
    const malicious = "foo'; rm -rf /; echo 'bar";
    const result = quoteShellValue(malicious);
    expect(result).toBe("'foo'\\''; rm -rf /; echo '\\''bar'");
  });
});
