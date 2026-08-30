export function publishHealthRecord(
  directory: string,
  path: string,
  record: unknown,
  options?: { write?: (fd: number, buffer: Buffer, offset: number, length: number) => number },
): void;
