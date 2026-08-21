import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { rtiAuthorityHint, schemeMatches } from "./legalAid";
import type { TrpcContext } from "./_core/context";

function createPublicContext(): TrpcContext {
  return {
    user: null,
    req: { headers: {} } as TrpcContext["req"],
    res: { cookie: () => undefined } as TrpcContext["res"],
  };
}

describe("legal-aid public procedure validation", () => {
  it("rejects a chat message that is too short before invoking an AI provider", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    await expect(caller.legalAid.chat({ message: "hi", language: "English" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects an unsupported language before invoking an AI provider", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    await expect(caller.legalAid.rightsGuide({ category: "tenant", language: "Gujarati" as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("maps local road information requests to a non-binding municipal or works authority hint", () => {
    expect(rtiAuthorityHint("Ward-wise road repair spending details")).toContain("municipal");
  });

  it("returns concrete structured scheme pathways for a housing profile", () => {
    const matches = schemeMatches({ category: "Housing", state: "Maharashtra", income: "250000" });
    expect(matches.map((match) => match.title)).toContain("Pradhan Mantri Awas Yojana — Urban / Gramin pathways");
    expect(matches.find((match) => match.title === "Pradhan Mantri Awas Yojana — Urban / Gramin pathways")).toMatchObject({ officialUrl: "https://pmay-urban.gov.in/" });
  });

  it("adds social-assistance review for a senior profile", () => {
    expect(schemeMatches({ age: "63" }).map((match) => match.title)).toContain("National Social Assistance Programme");
  });
});
