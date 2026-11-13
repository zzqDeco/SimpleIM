import { StringDecoder } from "node:string_decoder";

export interface ReadSecretOptions {
  fromStdin: boolean;
  prompt?: string;
  stdin?: NodeJS.ReadableStream;
  stderr?: NodeJS.WritableStream;
  allowEmpty?: boolean;
}

function readSingleLineFromStream(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let settled = false;

    const cleanup = () => {
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
      if ("pause" in stream && typeof stream.pause === "function") {
        stream.pause();
      }
    };

    const finish = (line: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(line.replace(/\r?\n$/, "").replace(/\r$/, ""));
    };

    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      buffer += text;
      const nlIdx = buffer.indexOf("\n");
      if (nlIdx >= 0) {
        finish(buffer.slice(0, nlIdx));
      }
    };

    const onEnd = () => {
      buffer += decoder.end();
      const nlIdx = buffer.indexOf("\n");
      finish(nlIdx >= 0 ? buffer.slice(0, nlIdx) : buffer);
    };

    const onError = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    if ("resume" in stream && typeof stream.resume === "function") {
      stream.resume();
    }
  });
}

function setTtyEcho(enabled: boolean): void {
  try {
    Bun.spawnSync(["stty", enabled ? "echo" : "-echo"], {
      stdin: "inherit",
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // Ignore if stty is unavailable in a non-standard environment
  }
}

async function readHiddenInteractiveLine(
  stdin: NodeJS.ReadableStream,
  stderr: NodeJS.WritableStream,
  promptText: string,
): Promise<string> {
  stderr.write(promptText);

  const ttyIn = stdin as NodeJS.ReadStream;
  const isRealTty = Boolean(ttyIn.isTTY);

  if (isRealTty && typeof ttyIn.setRawMode === "function") {
    const wasRaw = Boolean(ttyIn.isRaw);
    ttyIn.setRawMode(true);
    ttyIn.resume();
    try {
      return await new Promise<string>((resolve, reject) => {
        const decoder = new StringDecoder("utf8");
        const chars: string[] = [];
        let settled = false;

        const cleanup = () => {
          ttyIn.removeListener("data", onData);
          ttyIn.removeListener("end", onEnd);
          ttyIn.removeListener("error", onError);
        };

        const onData = (chunk: Buffer | string) => {
          const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
          for (const ch of text) {
            if (ch === "\r" || ch === "\n") {
              if (!settled) {
                settled = true;
                cleanup();
                resolve(chars.join(""));
              }
              return;
            }
            if (ch === "\x03") {
              if (!settled) {
                settled = true;
                cleanup();
                reject(new Error("Input aborted by user (SIGINT)"));
              }
              return;
            }
            if (ch === "\x04" && chars.length === 0) {
              if (!settled) {
                settled = true;
                cleanup();
                reject(new Error("Input closed (EOF)"));
              }
              return;
            }
            if (ch === "\x7f" || ch === "\x08") {
              chars.pop();
              continue;
            }
            if (ch >= " ") {
              chars.push(ch);
            }
          }
        };

        const onEnd = () => {
          if (!settled) {
            settled = true;
            cleanup();
            resolve(chars.join(""));
          }
        };

        const onError = (err: unknown) => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        };

        ttyIn.on("data", onData);
        ttyIn.on("end", onEnd);
        ttyIn.on("error", onError);
      });
    } finally {
      try {
        ttyIn.setRawMode(wasRaw);
        ttyIn.pause();
      } catch {
        // Ignore stream teardown errors
      }
      stderr.write("\n");
    }
  }

  if (isRealTty && stdin === process.stdin) {
    setTtyEcho(false);
    try {
      return await readSingleLineFromStream(stdin);
    } finally {
      setTtyEcho(true);
      stderr.write("\n");
    }
  }

  const line = await readSingleLineFromStream(stdin);
  stderr.write("\n");
  return line;
}

export async function readSecret(options: ReadSecretOptions): Promise<string> {
  const stdin = options.stdin ?? process.stdin;
  const stderr = options.stderr ?? process.stderr;
  const promptText = options.prompt ?? "Room passphrase: ";

  const raw = options.fromStdin
    ? await readSingleLineFromStream(stdin)
    : await readHiddenInteractiveLine(stdin, stderr, promptText);

  if (!options.allowEmpty && raw.length === 0) {
    throw new Error("Secret input must not be empty");
  }
  return raw;
}

export async function readPassphrase(options: {
  fromStdin: boolean;
  prompt?: string;
  stdin?: NodeJS.ReadableStream;
  stderr?: NodeJS.WritableStream;
}): Promise<string> {
  return readSecret({
    fromStdin: options.fromStdin,
    prompt: options.prompt ?? "Room passphrase: ",
    stdin: options.stdin,
    stderr: options.stderr,
  });
}

export async function readVisiblePrompt(options: {
  prompt: string;
  stdin?: NodeJS.ReadableStream;
  stderr?: NodeJS.WritableStream;
}): Promise<string> {
  const stdin = options.stdin ?? process.stdin;
  const stderr = options.stderr ?? process.stderr;
  stderr.write(options.prompt);
  const line = await readSingleLineFromStream(stdin);
  return line.trim();
}
