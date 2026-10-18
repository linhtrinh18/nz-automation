import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { controlSchema, jobSchema } from "./execution-state";
import type { Job } from "./execution-state";
export async function atomicJson(path: string, value: object): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(/*turbopackIgnore: true*/ temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
export class RunStore {
  constructor(public readonly root: string) {}
  path(id: string, name: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id) || !/^[a-zA-Z0-9_.-]+$/.test(name))
      throw new Error("Mã lượt chạy hoặc tên tệp không hợp lệ.");
    return join(this.root, id, name);
  }
  async prepare(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }
  async ids(): Promise<string[]> {
    await this.prepare();
    return (await readdir(this.root)).filter((id) =>
      /^[a-f0-9-]{36}$/.test(id),
    );
  }
  async read(id: string): Promise<Job> {
    return jobSchema.parse(
      JSON.parse(await readFile(this.path(id, "status.json"), "utf8")),
    );
  }
  async write(job: Job): Promise<void> {
    await atomicJson(this.path(job.id, "status.json"), jobSchema.parse(job));
  }
  async command(id: string) {
    return controlSchema.parse(
      JSON.parse(await readFile(this.path(id, "control.json"), "utf8")),
    );
  }
  async claim(id: string, token: string): Promise<void> {
    await this.prepare();
    try {
      const handle = await open(join(this.root, "active.json"), "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ id, token }));
      } finally {
        await handle.close();
      }
    } catch {
      throw new Error(
        "Đang có tác vụ hoặc khóa khởi động. Kết nối lại lượt đang chạy trước khi tạo lượt mới.",
      );
    }
  }
  async release(id: string, token: string): Promise<void> {
    const path = join(this.root, "active.json");
    try {
      const lock = JSON.parse(await readFile(path, "utf8")) as {
        id: string;
        token: string;
      };
      if (lock.id === id && lock.token === token) await unlink(path);
    } catch {
      /* Already released. */
    }
  }
}
