# CHATLAB — manual cloud reports (v1)

## Purpose and privacy

- **Nothing is uploaded automatically.** Only tapping **Push Report** sends a POST request.
- One report per chat session, identified by a stable `deviceId:sessionId`.
- Every subsequent Push of that session sends its *complete current snapshot* with the same ID. The server **upserts/replaces**, never inserts duplicate reports or appends duplicate runs.
- Metrics are included: model name/quant, device, prefill (prompt processing), decode (generation), TTFT, context size, maximum prompt token use, chat-turn count and per-turn measurements. Missing old measurements are labeled as missing, never fabricated.
- **Kèm nội dung chat** defaults OFF. Turning it ON and tapping Push requires a confirmation dialog. Turning it OFF and pushing again replaces the cloud snapshot and removes transcript text from the current row.
- Local inference and existing local chat history still work without any cloud setup or network.
- Credential is stored in Expo SecureStore; never hardcode it in source or GitHub Actions.
- Both app and server reject oversized payloads. Push failure leaves the local chat intact; no background retry runs.

## Deploy only to a dedicated, controlled Supabase project

**Do not run these files against an unrelated project's database** (for example an existing GSA project). Deploying the backend is a separate operation from committing source code.

1. Create/select the *CHATLAB-specific* Supabase project and connect it to the account used for reading reports.
2. Execute [schema.sql](../supabase/schema.sql) with the project's SQL editor. Table `public.chatlab_reports` has RLS enabled and no public/anon/authenticated policies or grants; only backend `service_role` accesses it.
3. Deploy [chatlab-report/index.ts](../supabase/functions/chatlab-report/index.ts) as Edge Function `chatlab-report`. Configure this function with **verify_jwt=false** because it requires a custom secret header before accepting any payload. Do not make a publicly writable function without that check.
4. Generate a strong random key (for example `openssl rand -hex 32`) and set the **Edge Function secret** `CHATLAB_REPORT_KEY` to the generated value. Keep it out of source and logs. Supabase Edge functions normally provide `SUPABASE_URL` and legacy `SUPABASE_SERVICE_ROLE_KEY` server-side; verify this on the new project. If unavailable, adapt server-only credential handling before deployment, never copy a service key into the app.
5. On CHATLAB open **Kết nối**, enter `https://<project-ref>.supabase.co/functions/v1/chatlab-report` and the **CHATLAB_REPORT_KEY** you just configured; save once. The key is used only in the `x-chatlab-report-key` header over HTTPS.
6. Start or open a saved chat, chat as usual, then press **↑ Push Report**. Reopen and Push the same chat again after additional turns to update it. Check the in-app success/failure message.

Important: a test APK built from a public GitHub repository contains **no cloud endpoint/key by default**. Only a user who configures the private endpoint and key can push; it is intentional not to publish a shared secret.

## Reading reports from ChatGPT / Supabase connector

Once the separate CHATLAB project is connected, query it through the connected Supabase tools on demand. Sample read-only SQL:

```sql
select
  report_id, updated_at, model_id, transcript_included,
  report -> 'summary' as summary,
  report -> 'session' as session
from public.chatlab_reports
order by updated_at desc
limit 30;
```

To inspect a particular chat including its content only if explicitly uploaded:

```sql
select report, updated_at
from public.chatlab_reports
where report_id = '<exact report id>';
```

These SELECTs are administrator operations through the authenticated Supabase connection; do not expose a public GET endpoint or put transcripts in public GitHub issues.

## Repeated manual pushes

First Push of chat `A`: create row with `report_id=device:A`.
After 10 more messages in `A`: Push again with the same `report_id`; the complete current summary, measurements and (if enabled) transcript replace that row, preserving the original row creation time.

New Chat `B`: receives a different ID, therefore a separate report row.

If the phone was offline, the push fails visibly. CHATLAB **does not** queue or auto-send later; press Push again when connected.

## Scope and known limitations

- Initial implementation intentionally does not upload model weights, system prompt, API tokens, device identifiers beyond the generated installation key, or location.
- Last 500 benchmark samples are retained locally by the MVP. Very long chats may outlive those samples; `missingMeasurements` reports the known gap.
- Average rates are arithmetic means over completed turns with positive native timing values. Compare per-turn data for serious performance analysis.
- App does not claim a successful push until server returns `{ok:true,reportId:<same-id>}`.
- Manual testing with an actual installed APK and a dedicated Supabase backend is still required. A passing TypeScript build alone is not a confirmed cloud integration test.
