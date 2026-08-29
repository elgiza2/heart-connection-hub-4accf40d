/** @doc Serverless speech-to-text endpoint used by the composer mic button. */
import { transcribeAudio } from "../src/lib/audio/transcribeCore";
import { apiHeaders, authenticateRequest } from "../src/lib/api/authenticateRequest";

export const config = { runtime: "nodejs" };

export default async function handler(req: Request): Promise<Response> {
  const headers = apiHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  }
  if (!(await authenticateRequest(req))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
  }

  try {
    const form = await req.formData();
    const file = form.get("file");
    const language = String(form.get("language") || "") || undefined;
    if (!(file instanceof Blob)) {
      return new Response(JSON.stringify({ text: "", error: "No audio uploaded" }), {
        status: 400,
        headers,
      });
    }
    const filename = (file as File).name || undefined;
    const { status, body } = await transcribeAudio(file, { language, filename });
    return new Response(JSON.stringify(body), { status, headers });
  } catch (err) {
    return new Response(
      JSON.stringify({ text: "", error: err instanceof Error ? err.message : "transcription failed" }),
      { status: 500, headers },
    );
  }
}
