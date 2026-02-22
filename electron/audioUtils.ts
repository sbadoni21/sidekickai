import { exec } from "child_process";

export function webmToWav(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(
      `ffmpeg -y -i "${input}" -ar 16000 -ac 1 -f wav "${output}"`,
      (err) => (err ? reject(err) : resolve())
    );
  });
}
