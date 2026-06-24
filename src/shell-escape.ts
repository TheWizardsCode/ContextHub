export function escapeShellArg(arg: string, platform?: string): string {
  const plat = platform ?? process.platform;
  if (plat === 'win32') {
    return '"' + arg.replace(/"/g, '\\"') + '"';
  }
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

export function quoteShellValue(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
