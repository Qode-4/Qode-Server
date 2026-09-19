import { z } from "zod";
import { traceable } from "langsmith/traceable";
import type { ProjectAnalysisSummary } from "../modules/project-analysis/project-analysis.types.js";

export type OpenAiMessageRole = "system" | "user" | "assistant";

export type OpenAiMessage = {
  role: OpenAiMessageRole;
  content: string;
};

const projectAnalysisSummarySchema: z.ZodType<ProjectAnalysisSummary> = z.object({
  project_overview: z.string().min(1),
  architecture: z.array(z.string()),
  core_modules: z.array(
    z.object({
      path: z.string().min(1),
      purpose: z.string().min(1),
    })
  ),
  key_flows: z.array(z.string()),
  risks: z.array(z.string()),
  recommended_next_steps: z.array(z.string()),
});

export class OpenAiClient {
  private readonly endpoint = "https://api.openai.com/v1/chat/completions";

  constructor(
    private readonly options: {
      apiKey: string;
      model: string;
      timeoutMs?: number;
    }
  ) {}

  async *streamChat(messages: OpenAiMessage[]): AsyncGenerator<string> {
    const endpoint = this.endpoint;
    const { apiKey, model, timeoutMs } = this.options;

    const streamOpenAiChat = traceable(
      async function* (input: { messages: OpenAiMessage[] }): AsyncGenerator<string> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs ?? 120_000);

        try {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model,
              temperature: 0.2,
              stream: true,
              messages: input.messages,
            }),
            signal: controller.signal,
          });

          if (!response.ok || !response.body) {
            const body = await response.text();
            throw new Error(`OpenAI stream request failed: ${response.status} ${body.slice(0, 500)}`);
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const chunks = buffer.split("\n\n");
            buffer = chunks.pop() ?? "";

            for (const chunk of chunks) {
              const line = chunk
                .split("\n")
                .find((item) => item.startsWith("data: "));
              if (!line) {
                continue;
              }

              const data = line.slice("data: ".length).trim();
              if (data === "[DONE]") {
                return;
              }

              let parsed: {
                choices?: Array<{ delta?: { content?: string } }>;
              };
              try {
                parsed = JSON.parse(data) as {
                  choices?: Array<{ delta?: { content?: string } }>;
                };
              } catch {
                continue;
              }

              const token = parsed.choices?.[0]?.delta?.content;
              if (token) {
                yield token;
              }
            }
          }
        } finally {
          clearTimeout(timer);
        }
      },
      {
        name: "openai_stream_chat",
        run_type: "llm",
        metadata: {
          provider: "openai",
          model,
          streaming: true,
        },
      }
    );

    yield* streamOpenAiChat({ messages });
  }

  async generateProjectAnalysis(input: {
    projectId: string;
    sourceCommit: string | null;
    repositorySnapshot: string;
  }): Promise<ProjectAnalysisSummary> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.options.model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are a senior staff engineer. Analyze repository context and respond in strict JSON only.",
          },
          {
            role: "user",
            content: [
              `project_id: ${input.projectId}`,
              `source_commit: ${input.sourceCommit ?? "unknown"}`,
              "",
              "Output JSON schema:",
              "{",
              '  "project_overview": "string",',
              '  "architecture": ["string"],',
              '  "core_modules": [{"path":"string","purpose":"string"}],',
              '  "key_flows": ["string"],',
              '  "risks": ["string"],',
              '  "recommended_next_steps": ["string"]',
              "}",
              "",
              "Repository context:",
              input.repositorySnapshot,
            ].join("\n"),
          },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI analysis request failed: ${response.status} ${body.slice(0, 500)}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI analysis response is empty");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("OpenAI analysis response is not valid JSON");
    }

    return projectAnalysisSummarySchema.parse(parsed);
  }
}
