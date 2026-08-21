import { TRPCError } from "@trpc/server";
import { parse } from "cookie";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { addChatMessage, ensureAnonymousSession, getChatHistory } from "./db";
import { getSessionCookieOptions } from "./_core/cookies";
import { invokeLLM } from "./_core/llm";
import { publicProcedure, router } from "./_core/trpc";

const ANONYMOUS_SESSION_COOKIE = "nyayapath_anon_session";
const LANGUAGE = z.enum(["English", "Hindi", "Tamil", "Telugu", "Bengali", "Marathi"]);
const textInput = z.string().trim().min(3).max(2_000);

type AiMessage = { role: "system" | "user" | "assistant"; content: string };

function getAnonymousSession(ctx: { req: { headers: { cookie?: string } }; res: { cookie: Function } }) {
  const existing = parse(ctx.req.headers.cookie ?? "")[ANONYMOUS_SESSION_COOKIE];
  if (existing) return existing;

  const token = randomUUID();
  ctx.res.cookie(ANONYMOUS_SESSION_COOKIE, token, {
    ...getSessionCookieOptions(ctx.req as never),
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
  return token;
}

async function askOpenAI(messages: AiMessage[]) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The AI guidance service is currently unavailable." });
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0.25, max_tokens: 800, messages }),
  });

  if (!response.ok) {
    console.error("[LegalAid] OpenAI request failed", response.status);
    try {
      const fallback = await invokeLLM({ messages });
      const fallbackAnswer = fallback.choices?.[0]?.message?.content;
      if (typeof fallbackAnswer === "string" && fallbackAnswer.trim()) return fallbackAnswer.trim();
    } catch (error) {
      console.error("[LegalAid] Server-side fallback failed", error);
    }
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The AI guidance service is currently unavailable." });
  }

  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const answer = payload.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The AI guidance service returned no answer." });
  return answer;
}

function legalSystem(language: z.infer<typeof LANGUAGE>) {
  return `You are NyayaPath, a cautious Indian civic and legal-information guide. Reply in ${language}. Use clear, accessible language and short sections. Provide general information only, not legal advice or a legal determination. Never invent laws, courts, deadlines, scheme eligibility, departments, or official links. Name Indian legislation only when confident, and say when location-specific rules can differ. Do not tell users to hide evidence or evade law. Encourage preserving relevant records and using official portals or NALSA where appropriate. If there is immediate danger, tell the user to contact emergency services. End with: "This is general information, not legal advice."`;
}

export function rtiAuthorityHint(issue: string) {
  const normalized = issue.toLowerCase();
  if (/road|street|drain|water|sewer|garbage|ward|municipal/.test(normalized)) return "Likely path to verify: the relevant municipal or local-body Public Information Officer; public-works records may also sit with a State or local Public Works Department.";
  if (/school|college|teacher|scholarship|education/.test(normalized)) return "Likely path to verify: the Education Department or the specific government educational institution that holds the records.";
  if (/ration|pension|welfare|scheme|benefit|subsidy/.test(normalized)) return "Likely path to verify: the Central or State department that administers the named welfare scheme.";
  if (/labour|labor|salary|wage|worker|employment/.test(normalized)) return "Likely path to verify: the relevant Labour Department or the public authority that holds the employment-related record.";
  return "Likely path to verify: use the official RTI Online public-authority directory for Central bodies, or identify the relevant State/UT public authority for State-held records.";
}

function legalContext(category: "tenant" | "consumer" | "workplace" | "family") {
  if (category === "consumer") return "When relevant, cite the Consumer Protection Act, 2019 and clearly distinguish pre-litigation help from filing before a Consumer Commission.";
  if (category === "tenant") return "Explain that tenancy and rent rules are primarily State-specific. You may mention the Model Tenancy Act, 2021 only as a model framework whose adoption varies by State/UT; do not suggest it automatically governs the user.";
  if (category === "workplace") return "When relevant, cite the Sexual Harassment of Women at Workplace (Prevention, Prohibition and Redressal) Act, 2013 for sexual-harassment concerns, or the Code on Wages, 2019 for wage context, while noting that applicable rules and coverage can vary.";
  return "Explain that family-law remedies depend on the facts, personal law, and local procedure. Do not cite a specific statute unless the user provides enough context.";
}

function rightsCitation(category: "tenant" | "consumer" | "workplace" | "family") {
  if (category === "tenant") return "**Legal context:** Tenancy rules are primarily State/UT-specific. The Model Tenancy Act, 2021 is a model framework and applies only where adopted by the relevant State/UT; confirm the local rent law or authority.";
  if (category === "consumer") return "**Legal context:** The Consumer Protection Act, 2019 provides the general consumer-protection framework, including consumer commissions. Keep proof of purchase and use the National Consumer Helpline for a pre-litigation route.";
  if (category === "workplace") return "**Legal context:** The Code on Wages, 2019 is relevant for wage context. For sexual-harassment concerns, the Sexual Harassment of Women at Workplace (Prevention, Prohibition and Redressal) Act, 2013 may be relevant; coverage and facts matter.";
  return "**Legal context:** The Family Courts Act, 1984 concerns family-court forums; substantive rights and remedies depend on the facts, personal law, and applicable State procedure. Seek legal-aid support for case-specific guidance.";
}

type SchemeProfile = { age?: string; income?: string; state?: string; category?: string };
const schemeMatchSchema = z.object({ title: z.string(), whyMatched: z.string(), eligibility: z.string(), officialUrl: z.string().url() });
type SchemeMatch = z.infer<typeof schemeMatchSchema>;

export function schemeMatches(profile: SchemeProfile): SchemeMatch[] {
  const value = profile.category?.toLowerCase() ?? "";
  const age = Number(profile.age);
  const state = profile.state?.trim();
  const profileNote = [state ? `State/UT: ${state}` : "State/UT not provided", Number.isFinite(age) ? `age: ${age}` : "age not provided", profile.income?.trim() ? "income provided" : "income not provided"].join(", ");
  const matches: SchemeMatch[] = [{ title: "myScheme", whyMatched: `A national starting point for the profile entered (${profileNote}).`, eligibility: "Use the official platform to confirm current Central and State/UT scheme criteria, benefits, documents, and application location.", officialUrl: "https://www.myscheme.gov.in/" }];
  if (value.includes("health")) matches.push({ title: "Ayushman Bharat PM-JAY", whyMatched: "The selected area is health and insurance.", eligibility: "Verify household coverage, State/UT implementation, and current beneficiary criteria through official channels; do not rely on this orientation alone.", officialUrl: "https://beneficiary.nha.gov.in/" });
  if (value.includes("education")) matches.push({ title: "National Scholarship Portal", whyMatched: "The selected area is education and scholarships.", eligibility: "Verify course, institution, category, academic, income, age, and scheme-specific conditions on the official portal.", officialUrl: "https://scholarships.gov.in/" });
  if (value.includes("livelihood")) matches.push({ title: "National Career Service", whyMatched: "The selected area is livelihood and employment.", eligibility: "Verify the programme, age, location, skills, and employment-status conditions relevant to each opportunity or scheme.", officialUrl: "https://www.ncs.gov.in/" });
  if (value.includes("housing")) matches.push({ title: "Pradhan Mantri Awas Yojana — Urban / Gramin pathways", whyMatched: "The selected area is housing.", eligibility: "Verify the current urban or rural pathway, household category, location, income definition, and housing-status conditions through the official portal.", officialUrl: "https://pmay-urban.gov.in/" });
  if (value.includes("social") || (Number.isFinite(age) && age >= 60)) matches.push({ title: "National Social Assistance Programme", whyMatched: value.includes("social") ? "The selected area is social assistance." : "The entered age is 60 or above; age can be relevant to some assistance pathways.", eligibility: "Verify the relevant pension or assistance category, age, income, and State/UT-administered conditions.", officialUrl: "https://nsap.nic.in/" });
  if (state) matches.push({ title: `${state} State/UT scheme search`, whyMatched: `The profile includes ${state}, so local schemes may be relevant in addition to Central programmes.`, eligibility: "Use myScheme with the State/UT filter to identify local programmes and confirm current eligibility, documents, and application steps.", officialUrl: "https://www.myscheme.gov.in/" });
  return schemeMatchSchema.array().parse(matches);
}

export const legalAidRouter = router({
  history: publicProcedure.query(async ({ ctx }) => {
    const token = getAnonymousSession(ctx as never);
    await ensureAnonymousSession(token);
    const messages = await getChatHistory(token);
    return messages.map(({ id, role, content, createdAt }) => ({ id, role, content, createdAt }));
  }),

  chat: publicProcedure.input(z.object({ message: textInput, language: LANGUAGE })).mutation(async ({ ctx, input }) => {
    const token = getAnonymousSession(ctx as never);
    await ensureAnonymousSession(token);
    await addChatMessage(token, "user", input.message);
    const history = await getChatHistory(token, 12);
    const answer = await askOpenAI([
      { role: "system", content: legalSystem(input.language) },
      ...history.map(({ role, content }) => ({ role, content })),
    ]);
    await addChatMessage(token, "assistant", answer);
    return { answer };
  }),

  draftRti: publicProcedure.input(z.object({ issue: textInput, authority: z.string().trim().max(120).optional(), name: z.string().trim().max(120).optional(), language: LANGUAGE })).mutation(async ({ input }) => {
    const departmentHint = rtiAuthorityHint(input.issue);
    const draft = await askOpenAI([{ role: "system", content: `${legalSystem(input.language)} Draft an editable RTI application. Begin with the supplied non-binding department guidance. Do not claim it is the correct authority. Use placeholders when details are missing. Mention that the Central RTI Online portal is not for State Government public authorities.` }, { role: "user", content: `Department guidance: ${departmentHint}\nInformation sought: ${input.issue}\nPossible authority/topic: ${input.authority ?? "Not provided"}\nApplicant name: ${input.name ?? "Not provided"}` }]);
    return { draft, departmentHint };
  }),

  rightsGuide: publicProcedure.input(z.object({ category: z.enum(["tenant", "consumer", "workplace", "family"]), details: z.string().trim().max(2_000).optional(), language: LANGUAGE })).mutation(async ({ input }) => {
    const guide = await askOpenAI([{ role: "system", content: `${legalSystem(input.language)} Provide a simple action guide in four numbered steps. Include safe evidence preservation, a proportionate written communication step, a relevant official pathway, and an uncertainty note. ${legalContext(input.category)} Do not diagnose, decide liability, or make threats.` }, { role: "user", content: `Category: ${input.category}\nSituation: ${input.details || "No additional details provided"}` }]);
    return { guide: `${rightsCitation(input.category)}\n\n${guide}` };
  }),

  schemeEligibility: publicProcedure.input(z.object({ age: z.string().trim().max(20).optional(), income: z.string().trim().max(40).optional(), state: z.string().trim().max(120).optional(), category: z.string().trim().max(120).optional(), language: LANGUAGE })).mutation(async ({ input }) => {
    const matches = schemeMatches(input);
    const guidance = await askOpenAI([{ role: "system", content: `${legalSystem(input.language)} Explain only the broad eligibility factors a citizen should verify for the supplied official scheme pathways. Do not state that they are eligible or ineligible. Direct them to the official myScheme portal to confirm current criteria, benefits, documents, and application steps.` }, { role: "user", content: `Suggested official pathways: ${matches.map(match => `${match.title}: ${match.eligibility}`).join(" | ")}\nAge: ${input.age || "Not provided"}\nIncome: ${input.income || "Not provided"}\nState/UT: ${input.state || "Not provided"}\nInterest area: ${input.category || "Not provided"}` }]);
    return { guidance, matches };
  }),
});
