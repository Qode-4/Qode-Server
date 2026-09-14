import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALLOWED_EXTENSIONS,
  EXCLUDE_DIRS,
  isIndexTarget,
  MAX_INDEX_FILES,
  MAX_REPO_BYTES,
  scanRepository,
} from "./repo-scan.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(resolve(tmpdir(), "qode-repo-scan-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const put = async (relativePath: string, content = "x") => {
  const full = resolve(root, relativePath);
  await mkdir(resolve(full, ".."), { recursive: true });
  await writeFile(full, content);
};

describe("인덱싱 대상 판별", () => {
  it("허용 확장자는 대상이다", () => {
    expect(isIndexTarget("index.ts")).toBe(true);
    expect(isIndexTarget("main.py")).toBe(true);
  });

  it("허용 목록에 없는 확장자는 대상이 아니다", () => {
    // 2026-09-08 Qode-python 3feae6d 에서 .md/.txt 가 인덱싱 대상에서 빠졌다.
    expect(isIndexTarget("README.md")).toBe(false);
    expect(isIndexTarget("notes.txt")).toBe(false);
    expect(isIndexTarget("logo.png")).toBe(false);
  });

  it("확장자가 없으면 대상이 아니다", () => {
    expect(isIndexTarget("Makefile")).toBe(false);
  });

  it("제외 패턴은 확장자가 맞아도 대상이 아니다", () => {
    expect(isIndexTarget("bundle.min.js")).toBe(false);
    expect(isIndexTarget("package-lock.json")).toBe(false);
    expect(isIndexTarget("yarn.lock")).toBe(false);
  });

  it("대소문자가 달라도 확장자를 알아본다", () => {
    expect(isIndexTarget("App.TS")).toBe(true);
  });
});

describe("레포 스캔", () => {
  it("빈 폴더는 0개 0바이트", async () => {
    expect(await scanRepository(root)).toEqual({ fileCount: 0, byteSize: 0 });
  });

  it("중첩 폴더까지 센다", async () => {
    await put("a.ts");
    await put("src/b.ts");
    await put("src/deep/c.py");

    expect((await scanRepository(root)).fileCount).toBe(3);
  });

  it("제외 디렉터리 안은 세지 않는다", async () => {
    await put("a.ts");
    for (const dir of EXCLUDE_DIRS) {
      await put(`${dir}/ignored.ts`);
    }

    expect((await scanRepository(root)).fileCount).toBe(1);
  });

  it("크기에는 .git 이 빠진다", async () => {
    await put("a.ts", "1234567890");
    await put(".git/objects/big", "x".repeat(5000));

    expect((await scanRepository(root)).byteSize).toBe(10);
  });

  it("크기는 인덱싱 대상이 아닌 파일도 포함한다", async () => {
    // 레포 용량 한도는 "받아온 코드가 얼마나 큰가"이지 "무엇을 인덱싱하나"가 아니다.
    await put("a.ts", "12345");
    await put("logo.png", "1234567890");

    const scan = await scanRepository(root);
    expect(scan.fileCount).toBe(1);
    expect(scan.byteSize).toBe(15);
  });
});

describe("한도 상수", () => {
  it("명세 A-4 의 값이다", () => {
    expect(MAX_REPO_BYTES).toBe(500 * 1024 * 1024);
    expect(MAX_INDEX_FILES).toBe(10_000);
  });

  it("허용 확장자가 Qode-python filters.py 와 같다", () => {
    // 두 서비스가 "인덱싱 대상"을 다르게 보면 서버가 막은 레포를 파이썬은 받아들인다.
    // filters.py 의 ALLOWED_EXTENSIONS 를 바꾸면 이 테스트가 먼저 깨져야 한다.
    expect([...ALLOWED_EXTENSIONS].sort()).toEqual(
      [
        ".go", ".java", ".js", ".json", ".jsx", ".py", ".rb", ".rs",
        ".sql", ".ts", ".tsx", ".yaml", ".yml",
      ].sort()
    );
  });
});
