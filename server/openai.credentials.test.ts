import { describe, expect, it } from "vitest";

describe("OpenAI server credential", () => {
  it("can authenticate to the models endpoint from the server environment", async () => {
    const apiKey = process.env.OPENAI_API_KEY;
    expect(apiKey).toMatch(/^sk-/);

    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    expect(response.ok).toBe(true);
  }, 15_000);
});
