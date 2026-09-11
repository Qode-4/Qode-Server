// 질문 목록을 순서대로 던져 AI 답변을 수집하고 CSV로 저장하는 배치 테스트 스크립트.
//
// 사용법:
//   BASE_URL=http://localhost:3000 TOKEN=<액세스토큰> PROJECT_ID=<프로젝트uuid> \
//     node scripts/batch-qa-test.mjs [질문파일] [출력csv]
//
//   질문파일 기본값: scripts/questions.txt (한 줄에 질문 하나, 빈 줄/# 주석 무시)
//   출력 기본값:    scripts/qa-results-<타임스탬프>.csv
//
// 질문마다 새 PERSONAL 채팅을 만들어 이전 대화 맥락이 답변에 섞이지 않게 한다.

import { readFileSync, writeFileSync } from "node:fs";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const TOKEN = process.env.TOKEN;
const PROJECT_ID = process.env.PROJECT_ID;
if (!TOKEN || !PROJECT_ID) {
  console.error("TOKEN, PROJECT_ID 환경변수가 필요합니다.");
  process.exit(1);
}

const questionsFile = process.argv[2] ?? new URL("./questions.txt", import.meta.url).pathname;
const outFile =
  process.argv[3] ??
  new URL(`./qa-results-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`, import.meta.url)
    .pathname;

const questions = readFileSync(questionsFile, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

if (questions.length === 0) {
  console.error(`질문이 없습니다: ${questionsFile}`);
  process.exit(1);
}

const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

const createChat = async (name) => {
  const res = await fetch(`${BASE_URL}/api/chats/me`, {
    method: "POST",
    headers,
    body: JSON.stringify({ project_id: PROJECT_ID, chat_type: "PERSONAL", name }),
  });
  if (!res.ok) throw new Error(`채팅 생성 실패 ${res.status}: ${await res.text()}`);
  return (await res.json()).data.id;
};

// SSE 스트림을 파싱해 token 이벤트를 답변으로 누적한다.
const askQuestion = async (chatId, content) => {
  const res = await fetch(`${BASE_URL}/api/chats/me/${chatId}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`메시지 전송 실패 ${res.status}: ${await res.text()}`);

  let answer = "";
  let sources = [];
  let errorMessage = null;
  let buffer = "";

  const handleEvent = (raw) => {
    const event = /^event: (.*)$/m.exec(raw)?.[1];
    const dataLine = /^data: (.*)$/m.exec(raw)?.[1];
    if (!event || dataLine === undefined) return;
    const data = JSON.parse(dataLine);
    if (event === "token") answer += data.token;
    else if (event === "sources") sources = data.sources;
    else if (event === "error") errorMessage = data.message;
  };

  for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      handleEvent(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  }

  if (errorMessage) throw new Error(errorMessage);
  return { answer, sources };
};

const csvCell = (v) => `"${String(v).replaceAll('"', '""')}"`;

const rows = [["no", "question", "answer", "sources", "duration_ms", "status"]];

for (const [i, question] of questions.entries()) {
  const no = i + 1;
  process.stdout.write(`[${no}/${questions.length}] ${question.slice(0, 50)} ... `);
  const started = Date.now();
  try {
    const chatId = await createChat(`qa-test-${no}`);
    const { answer, sources } = await askQuestion(chatId, question);
    rows.push([no, question, answer, JSON.stringify(sources), Date.now() - started, "OK"]);
    console.log(`OK (${Date.now() - started}ms, ${answer.length}자)`);
  } catch (err) {
    rows.push([no, question, "", "", Date.now() - started, `ERROR: ${err.message}`]);
    console.log(`실패: ${err.message}`);
  }
}

// 엑셀 한글 깨짐 방지용 BOM
writeFileSync(outFile, "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\n"), "utf8");

const okCount = rows.slice(1).filter((r) => r[5] === "OK").length;
console.log(`\n완료: ${okCount}/${questions.length} 성공 → ${outFile}`);
