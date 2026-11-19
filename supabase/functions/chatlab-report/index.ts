// CHATLAB manual report receiver.
// Deploy only to a dedicated Supabase project with verify_jwt = false.
// Custom header auth is mandatory before parsing the request body.
const MAX_BYTES = 750_000;
const encoder = new TextEncoder();

function json(status: number, value: Record<string, unknown>): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function matchesKey(provided: string | null, expected: string): boolean {
  if (!provided || !expected || provided.length !== expected.length) return false;
  const a = encoder.encode(provided);
  const b = encoder.encode(expected);
  let mismatch = 0;
  for (let index = 0; index < a.length; index++) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}

function isReport(x: unknown): x is {
  reportId: string;
  sessionId: string;
  includeTranscript: boolean;
  session: { model: { id: string }; turns: number; messages: number };
  benchmarks: unknown[];
  transcript: unknown[] | null;
} {
  if (!x || typeof x !== 'object') return false;
  const v = x as Record<string, unknown>;
  const session = v.session as Record<string, unknown> | undefined;
  const model = session?.model as Record<string, unknown> | undefined;
  const transcript = v.transcript;
  if (
    v.schemaVersion !== 1 ||
    typeof v.reportId !== 'string' ||
    !/^[A-Za-z0-9_.:-]{8,180}$/.test(v.reportId) ||
    typeof v.sessionId !== 'string' ||
    !v.reportId.endsWith(':' + v.sessionId) ||
    typeof model?.id !== 'string' ||
    model.id.length === 0 || model.id.length > 100 ||
    typeof v.includeTranscript !== 'boolean' ||
    typeof session?.turns !== 'number' || !Number.isInteger(session.turns) ||
    session.turns < 0 || session.turns > 100_000 ||
    typeof session.messages !== 'number' || !Number.isInteger(session.messages) ||
    session.messages < 0 || session.messages > 200_000 ||
    !Array.isArray(v.benchmarks) || v.benchmarks.length > 1000
  ) return false;

  if (!v.includeTranscript) return transcript === null;
  return Array.isArray(transcript) &&
    transcript.length === session.messages &&
    transcript.every((m: unknown) => {
      if (!m || typeof m !== 'object') return false;
      const row = m as Record<string, unknown>;
      return (row.role === 'user' || row.role === 'assistant') &&
        typeof row.text === 'string' && row.text.length <= 300_000;
    });
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
  const expectedKey = Deno.env.get('CHATLAB_REPORT_KEY') ?? '';
  if (expectedKey.length < 24 || !matchesKey(request.headers.get('x-chatlab-report-key'), expectedKey)) {
    return json(401, { ok: false, error: 'unauthorized' });
  }
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_BYTES) return json(413, { ok: false, error: 'too_large' });

  let report: unknown;
  try {
    const raw = await request.text();
    if (encoder.encode(raw).byteLength > MAX_BYTES) {
      return json(413, { ok: false, error: 'too_large' });
    }
    report = JSON.parse(raw);
  } catch {
    return json(400, { ok: false, error: 'invalid_json' });
  }
  if (!isReport(report)) return json(422, { ok: false, error: 'invalid_report' });

  const base = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!base || !serviceKey) return json(503, { ok: false, error: 'backend_not_configured' });

  try {
    // Same report_id => full snapshot replacement, including removal of a
    // previously shared transcript when the user later unchecks the option.
    const row = {
      report_id: report.reportId,
      session_id: report.sessionId,
      model_id: report.session.model.id,
      transcript_included: report.includeTranscript,
      updated_at: new Date().toISOString(),
      report,
    };
    const response = await fetch(
      base.replace(/\/$/, '') + '/rest/v1/chatlab_reports?on_conflict=report_id',
      {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: 'Bearer ' + serviceKey,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(row),
      },
    );
    if (!response.ok) {
      // No database SQL/credentials or raw transcript in API response.
      return json(502, { ok: false, error: 'storage_failed' });
    }
    return json(200, { ok: true, reportId: report.reportId, mode: 'upsert' });
  } catch {
    return json(503, { ok: false, error: 'storage_unavailable' });
  }
});
