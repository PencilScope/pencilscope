type Environment = { DB: D1Database; ENVIRONMENT: string };
type AccessContext = ExecutionContext & { access?: { getIdentity(): Promise<{ email?: string } | null> } };
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });

async function authorize(request: Request, env: Environment, ctx: AccessContext) {
  const identity = await ctx.access?.getIdentity();
  const email = identity?.email?.toLowerCase() ??
    (env.ENVIRONMENT === "development" ? request.headers.get("x-pencilscope-admin-email")?.toLowerCase() : null);
  if (!email) return null;
  return env.DB.prepare(
    `SELECT u.id, u.display_name, pr.role FROM users u JOIN platform_roles pr ON pr.user_id = u.id
     WHERE LOWER(u.email) = ? AND u.status = 'active' AND pr.revoked_at IS NULL
       AND pr.role IN ('system_admin', 'finance', 'auditor')
     ORDER BY CASE pr.role WHEN 'system_admin' THEN 0 WHEN 'finance' THEN 1 ELSE 2 END LIMIT 1`
  ).bind(email).first<{ id: string; display_name: string; role: string }>();
}

const shell = (name: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>PencilScope Billing</title><style>
:root{font-family:system-ui,sans-serif;color:#102a56;background:#eef6ff}*{box-sizing:border-box}body{margin:0}header{padding:22px 30px;display:flex;justify-content:space-between;color:#fff;background:#102a56}main{width:min(1320px,calc(100% - 32px));margin:30px auto}.metrics{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}.card,.panel{padding:20px;border:1px solid #d7e2f0;border-radius:13px;background:#fff}.card strong{display:block;font-size:30px}.card span,small{color:#53677f}.panel{margin-top:22px;overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:11px;text-align:left;border-bottom:1px solid #d7e2f0}th{color:#53677f;font-size:10px;text-transform:uppercase}button{padding:9px 13px;border:0;border-radius:8px;color:#fff;background:#1d4ed8;cursor:pointer}.status{padding:4px 7px;border-radius:99px;background:#e8f1ff;font-size:10px;font-weight:700}.status.held,.status.open,.status.reviewing{color:#832f24;background:#fde7e2}@media(max-width:850px){.metrics{grid-template-columns:1fr 1fr}}</style></head><body><header><strong>PencilScope · Billing</strong><span>${name}</span></header><main><div><button data-view="overview">Overview</button> <button data-view="orders">Payments</button> <button data-view="subscriptions">Course subscriptions</button> <button data-view="settlements">Creator settlements</button> <button data-view="disputes">Disputes</button> <button data-view="meeting-usage">Meeting usage</button></div><div id="content"></div></main><script>
const out=document.querySelector('#content'),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),money=(v,c='SGD')=>new Intl.NumberFormat('en-SG',{style:'currency',currency:c}).format(Number(v||0)/100);
const table=(cols,rows)=>'<div class="panel"><table><thead><tr>'+cols.map(c=>'<th>'+esc(c[0])+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+cols.map(c=>'<td>'+c[1](r)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
async function load(view='overview'){out.innerHTML='<p>Loading…</p>';const r=await fetch('/api/billing/'+view),d=await r.json();if(!r.ok){out.textContent=d.error;return}
if(view==='overview')out.innerHTML='<div class="metrics">'+[['Gross volume',money(d.grossCents,d.currency)],['Pending creator payout',money(d.pendingPayoutCents,d.currency)],['Ready for payout',money(d.eligiblePayoutCents,d.currency)],['Transferred',money(d.transferredCents,d.currency)],['Open disputes',d.openDisputes]].map(x=>'<div class="card"><strong>'+esc(x[1])+'</strong><span>'+esc(x[0])+'</span></div>').join('')+'</div>';
if(view==='orders')out.innerHTML='<h1>Payment history</h1>'+table([['Learner',r=>'<strong>'+esc(r.learner_name)+'</strong><br><small>'+esc(r.learner_email)+'</small>'],['Course',r=>esc(r.course_title)+'<br><small>'+esc(r.offering_title||'')+'</small>'],['Provider reference',r=>'<small>'+esc(r.stripe_payment_intent_id||r.stripe_checkout_session_id)+'</small>'],['Status',r=>esc(r.status)],['Amount',r=>money(r.amount_cents,r.currency)],['Date',r=>esc(r.created_at)]],d.orders);
if(view==='subscriptions')out.innerHTML='<h1>Course subscriptions</h1>'+table([['Learner',r=>'<strong>'+esc(r.learner_name)+'</strong><br><small>'+esc(r.learner_email)+'</small>'],['Course',r=>esc(r.course_title)+'<br><small>'+esc(r.offering_title)+'</small>'],['Status',r=>esc(r.status)],['Enrolled',r=>esc(r.enrolled_at)],['Payment',r=>money(r.amount_cents,r.currency)]],d.subscriptions);
if(view==='settlements')out.innerHTML='<h1>Creator settlements</h1>'+table([['Creator',r=>'<strong>'+esc(r.creator_name)+'</strong><br><small>'+esc(r.creator_email)+'</small>'],['Course',r=>esc(r.course_title)+'<br><small>'+esc(r.offering_title||'')+'</small>'],['Gross',r=>money(r.gross_cents,r.currency)],['Deductions',r=>money(Number(r.processing_fee_cents)+Number(r.platform_fee_cents)+Number(r.meeting_usage_fee_cents)+Number(r.refund_cents)+Number(r.reserve_cents),r.currency)],['Net',r=>'<strong>'+money(r.payable_cents,r.currency)+'</strong>'],['Status',r=>'<span class="status '+esc(r.status)+'">'+esc(r.status.replaceAll('_',' '))+'</span>'],['Release date',r=>esc(r.review_ends_at||'—')]],d.settlements);
if(view==='disputes')out.innerHTML='<h1>Payment disputes and learner issues</h1>'+table([['Learner',r=>'<strong>'+esc(r.learner_name)+'</strong><br><small>'+esc(r.learner_email)+'</small>'],['Course',r=>esc(r.course_title)],['Type',r=>esc(r.case_type.replaceAll('_',' '))],['Reason',r=>esc(r.reason)],['Amount',r=>money(r.amount_cents,r.currency)],['Status',r=>'<span class="status '+esc(r.status)+'">'+esc(r.status)+'</span>'],['Opened',r=>esc(r.opened_at)]],d.disputes);
if(view==='meeting-usage')out.innerHTML='<h1>Online class usage</h1>'+table([['Course',r=>'<strong>'+esc(r.course_title)+'</strong><br><small>'+esc(r.session_title)+'</small>'],['Provider',r=>esc(r.provider)],['Participant minutes',r=>esc(r.participant_minutes)],['Rate',r=>'$'+(Number(r.rate_micros)/1000000).toFixed(4)+' / participant-minute'],['Cost',r=>money(r.amount_cents,'SGD')],['Finalised',r=>esc(r.finalized_at||'Pending')]],d.usage)}
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>load(b.dataset.view));load();</script></body></html>`;

export default {
  async fetch(request, env, context): Promise<Response> {
    const actor = await authorize(request, env, context as AccessContext);
    if (!actor) return json({ error: "Access denied." }, 403);
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response(shell(actor.display_name), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" } });
    const route = url.pathname.replace(/^\/api\/billing\//, "");
    if (request.method === "GET" && route === "overview") {
      const totals = await env.DB.prepare(
        `SELECT COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_cents ELSE 0 END),0) AS gross,
          COALESCE(SUM(CASE WHEN status = 'refunded' THEN amount_cents ELSE 0 END),0) AS refunded,
          SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid_orders,
          COALESCE(MAX(currency),'SGD') AS currency FROM orders`
      ).first<{ gross: number; refunded: number; paid_orders: number; currency: string }>();
      const learners = await env.DB.prepare(
        "SELECT COUNT(DISTINCT student_user_id) AS total FROM enrolment_offerings WHERE status = 'active'"
      ).first<{ total: number }>();
      const settlements = await env.DB.prepare(
        `SELECT
          COALESCE(SUM(CASE WHEN status NOT IN ('transferred','paid','zero_balance','reversed') THEN payable_cents ELSE 0 END),0) AS pending,
          COALESCE(SUM(CASE WHEN status = 'eligible' THEN payable_cents ELSE 0 END),0) AS eligible,
          COALESCE(SUM(CASE WHEN status IN ('transferred','paid') THEN payable_cents ELSE 0 END),0) AS transferred
         FROM creator_earnings`
      ).first<{ pending: number; eligible: number; transferred: number }>();
      const disputes = await env.DB.prepare(
        "SELECT COUNT(*) AS total FROM learner_payment_cases WHERE status IN ('open','reviewing')"
      ).first<{ total: number }>();
      return json({
        grossCents: totals?.gross ?? 0,
        refundedCents: totals?.refunded ?? 0,
        paidOrders: totals?.paid_orders ?? 0,
        activeLearners: learners?.total ?? 0,
        pendingPayoutCents: settlements?.pending ?? 0,
        eligiblePayoutCents: settlements?.eligible ?? 0,
        transferredCents: settlements?.transferred ?? 0,
        openDisputes: disputes?.total ?? 0,
        currency: totals?.currency ?? "SGD"
      });
    }
    if (request.method === "GET" && route === "orders") {
      const result = await env.DB.prepare(
        `SELECT o.*, c.title AS course_title, co.title AS offering_title,
          u.display_name AS learner_name, u.email AS learner_email
         FROM orders o JOIN courses c ON c.id = o.course_id
         LEFT JOIN course_offerings co ON co.id = o.course_offering_id
         JOIN users u ON u.id = o.student_user_id
         ORDER BY o.created_at DESC LIMIT 2000`
      ).all();
      return json({ orders: result.results });
    }
    if (request.method === "GET" && route === "subscriptions") {
      const result = await env.DB.prepare(
        `SELECT eo.id, eo.status, eo.enrolled_at, u.display_name AS learner_name,
          u.email AS learner_email, c.title AS course_title, co.title AS offering_title,
          o.amount_cents, o.currency, o.status AS payment_status
         FROM enrolment_offerings eo JOIN users u ON u.id = eo.student_user_id
         JOIN course_offerings co ON co.id = eo.course_offering_id
         JOIN courses c ON c.id = co.course_id LEFT JOIN orders o ON o.id = eo.order_id
         ORDER BY eo.enrolled_at DESC LIMIT 2000`
      ).all();
      return json({ subscriptions: result.results });
    }
    if (request.method === "GET" && route === "settlements") {
      const result = await env.DB.prepare(
        `SELECT ce.*, c.title AS course_title, co.title AS offering_title,
          u.display_name AS creator_name, u.email AS creator_email
         FROM creator_earnings ce JOIN courses c ON c.id = ce.course_id
         JOIN users u ON u.id = ce.creator_user_id
         LEFT JOIN course_offerings co ON co.id = ce.course_offering_id
         ORDER BY ce.updated_at DESC LIMIT 2000`
      ).all();
      return json({ settlements: result.results });
    }
    if (request.method === "GET" && route === "disputes") {
      const result = await env.DB.prepare(
        `SELECT pc.*, o.currency, c.title AS course_title,
          u.display_name AS learner_name, u.email AS learner_email
         FROM learner_payment_cases pc JOIN orders o ON o.id = pc.order_id
         JOIN courses c ON c.id = o.course_id JOIN users u ON u.id = o.student_user_id
         ORDER BY CASE pc.status WHEN 'open' THEN 0 WHEN 'reviewing' THEN 1 ELSE 2 END,
          pc.opened_at DESC LIMIT 2000`
      ).all();
      return json({ disputes: result.results });
    }
    if (request.method === "GET" && route === "meeting-usage") {
      const result = await env.DB.prepare(
        `SELECT mu.*, c.title AS course_title, s.title AS session_title
         FROM meeting_usage_records mu JOIN course_sessions s ON s.id = mu.course_session_id
         JOIN course_offerings co ON co.id = mu.course_offering_id
         JOIN courses c ON c.id = co.course_id
         ORDER BY mu.observed_at DESC LIMIT 2000`
      ).all();
      return json({ usage: result.results });
    }
    return json({ error: "Not found." }, 404);
  }
} satisfies ExportedHandler<Environment>;
