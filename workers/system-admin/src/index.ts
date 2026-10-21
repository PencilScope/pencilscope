type Environment = {
  DB: D1Database;
  CORE_API: Fetcher;
  CONTACT_ENQUIRIES: R2Bucket;
  ENVIRONMENT: string;
};

type AccessContext = ExecutionContext & {
  access?: { getIdentity(): Promise<{ email?: string } | null> };
};

const html = (body: string, status = 200) => new Response(body, {
  status,
  headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  }
});
const json = (value: unknown, status = 200) => Response.json(value, {
  status,
  headers: { "cache-control": "no-store" }
});
const total = (result: D1Result) => Number((result.results[0] as { total?: number } | undefined)?.total ?? 0);

type ContactCatalogueRow = {
  id: string; reference_code: string; object_key: string; checksum_sha256: string;
  display_name: string; country_code: string; country_name: string; enquiry_type: string;
  phone_last4: string; source_path: string; status: string; created_at: string; updated_at: string;
  resolved_at: string | null; deleted_at: string | null; recoverable_until: string | null; purged_at: string | null;
};

const digestHex = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((part) => part.toString(16).padStart(2, "0")).join("");
};

async function purgeExpiredEnquiries(env: Environment): Promise<number> {
  const now = new Date().toISOString();
  const expired = await env.DB.prepare(
    `SELECT id, object_key FROM contact_enquiries
     WHERE status = 'deleted' AND purged_at IS NULL AND recoverable_until <= ?
     ORDER BY recoverable_until LIMIT 50`
  ).bind(now).all<{ id: string; object_key: string }>();
  for (const row of expired.results) {
    await env.CONTACT_ENQUIRIES.delete(row.object_key);
    await env.DB.prepare(
      "UPDATE contact_enquiries SET purged_at = ?, updated_at = ? WHERE id = ? AND purged_at IS NULL"
    ).bind(now, now, row.id).run();
  }
  return expired.results.length;
}

async function identityEmail(request: Request, env: Environment, ctx: AccessContext): Promise<string | null> {
  const identity = await ctx.access?.getIdentity();
  if (identity?.email) return identity.email.toLowerCase();
  if (env.ENVIRONMENT === "development") {
    return request.headers.get("x-pencilscope-admin-email")?.trim().toLowerCase() || null;
  }
  return null;
}

async function authorize(request: Request, env: Environment, ctx: AccessContext) {
  const email = await identityEmail(request, env, ctx);
  if (!email) return null;
  return env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, pr.role
     FROM users u JOIN platform_roles pr ON pr.user_id = u.id
     WHERE LOWER(u.email) = ? AND u.status = 'active' AND pr.revoked_at IS NULL
       AND pr.role IN ('system_admin', 'support', 'auditor')
     ORDER BY CASE pr.role WHEN 'system_admin' THEN 0 WHEN 'support' THEN 1 ELSE 2 END LIMIT 1`
  ).bind(email).first<{ id: string; email: string; display_name: string; role: string }>();
}

async function audit(env: Environment, actorId: string, action: string, entityId: string, metadata: unknown, entityType = "user") {
  return env.DB.prepare(
    `INSERT INTO audit_logs
      (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(crypto.randomUUID(), actorId, action, entityType, entityId, JSON.stringify(metadata), new Date().toISOString()).run();
}

const SINGAPORE_OFFSET_MS = 8 * 60 * 60 * 1000;

function activityWindow(period: string, now = new Date()) {
  const singaporeNow = new Date(now.getTime() + SINGAPORE_OFFSET_MS);
  const dayStart = Date.UTC(
    singaporeNow.getUTCFullYear(), singaporeNow.getUTCMonth(), singaporeNow.getUTCDate()
  ) - SINGAPORE_OFFSET_MS - (period === "yesterday" ? 86_400_000 : 0);
  return {
    period: period === "yesterday" ? "yesterday" : "today",
    start: new Date(dayStart).toISOString(),
    end: new Date(dayStart + 86_400_000).toISOString()
  };
}

type ActivityUser = {
  userId: string; name: string; role: string; countryCode: string | null; city: null;
  lastActive: string; auditEvents: number; learningEvents: number; assessmentAttempts: number;
  mcpCalls: number; rejectedActions: number; orders: number; activities: Set<string>;
};

async function activitySnapshot(env: Environment, requestedPeriod: string) {
  const window = activityWindow(requestedPeriod);
  const [auditRows, learningRows, attemptRows, mcpRows, orderRows, operational] = await env.DB.batch([
    env.DB.prepare(
      `SELECT u.id AS user_id, u.display_name, u.role, ap.country_code, a.action,
        COUNT(*) AS event_count, MAX(a.created_at) AS last_at
       FROM audit_logs a JOIN users u ON u.id = a.actor_user_id
       LEFT JOIN account_profiles ap ON ap.user_id = u.id
       WHERE a.created_at >= ? AND a.created_at < ?
       GROUP BY u.id, u.display_name, u.role, ap.country_code, a.action`
    ).bind(window.start, window.end),
    env.DB.prepare(
      `SELECT u.id AS user_id, u.display_name, u.role, ap.country_code, l.activity_type,
        COUNT(*) AS event_count, MAX(l.created_at) AS last_at
       FROM learning_product_activity l JOIN users u ON u.id = l.user_id
       LEFT JOIN account_profiles ap ON ap.user_id = u.id
       WHERE l.created_at >= ? AND l.created_at < ?
       GROUP BY u.id, u.display_name, u.role, ap.country_code, l.activity_type`
    ).bind(window.start, window.end),
    env.DB.prepare(
      `SELECT u.id AS user_id, u.display_name, u.role, ap.country_code,
        COUNT(*) AS event_count, MAX(x.submitted_at) AS last_at
       FROM learning_product_attempts x JOIN users u ON u.id = x.user_id
       LEFT JOIN account_profiles ap ON ap.user_id = u.id
       WHERE x.submitted_at >= ? AND x.submitted_at < ?
       GROUP BY u.id, u.display_name, u.role, ap.country_code`
    ).bind(window.start, window.end),
    env.DB.prepare(
      `SELECT u.id AS user_id, u.display_name, u.role, ap.country_code, m.tool_name,
        m.succeeded, COUNT(*) AS event_count, MAX(m.created_at) AS last_at
       FROM mcp_tool_calls m JOIN users u ON u.id = m.user_id
       LEFT JOIN account_profiles ap ON ap.user_id = u.id
       WHERE m.created_at >= ? AND m.created_at < ?
       GROUP BY u.id, u.display_name, u.role, ap.country_code, m.tool_name, m.succeeded`
    ).bind(window.start, window.end),
    env.DB.prepare(
      `SELECT u.id AS user_id, u.display_name, u.role, ap.country_code, o.status,
        COUNT(*) AS event_count, MAX(o.created_at) AS last_at
       FROM orders o JOIN users u ON u.id = o.student_user_id
       LEFT JOIN account_profiles ap ON ap.user_id = u.id
       WHERE o.created_at >= ? AND o.created_at < ?
       GROUP BY u.id, u.display_name, u.role, ap.country_code, o.status`
    ).bind(window.start, window.end),
    env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM users WHERE created_at >= ? AND created_at < ?) AS new_users,
        (SELECT COUNT(*) FROM webhook_events WHERE status = 'failed' AND received_at >= ? AND received_at < ?) AS failed_webhooks,
        (SELECT COUNT(*) FROM orders WHERE status = 'failed' AND updated_at >= ? AND updated_at < ?) AS failed_orders,
        (SELECT COUNT(*) FROM settlement_transfers WHERE status = 'failed' AND updated_at >= ? AND updated_at < ?) AS failed_settlements,
        (SELECT COUNT(*) FROM creator_earnings WHERE last_error IS NOT NULL AND updated_at >= ? AND updated_at < ?) AS earning_errors`
    ).bind(
      window.start, window.end, window.start, window.end, window.start, window.end,
      window.start, window.end, window.start, window.end
    )
  ]);
  const users = new Map<string, ActivityUser>();
  const ensureUser = (row: Record<string, unknown>) => {
    const userId = String(row.user_id);
    let user = users.get(userId);
    if (!user) {
      user = {
        userId, name: String(row.display_name), role: String(row.role),
        countryCode: row.country_code ? String(row.country_code) : null, city: null,
        lastActive: String(row.last_at), auditEvents: 0, learningEvents: 0,
        assessmentAttempts: 0, mcpCalls: 0, rejectedActions: 0, orders: 0,
        activities: new Set<string>()
      };
      users.set(userId, user);
    }
    if (String(row.last_at) > user.lastActive) user.lastActive = String(row.last_at);
    return user;
  };
  let signedIns = 0;
  for (const row of auditRows.results as Record<string, unknown>[]) {
    const user = ensureUser(row); const count = Number(row.event_count);
    user.auditEvents += count; user.activities.add(String(row.action));
    if (row.action === "session.signed_in") signedIns += count;
  }
  for (const row of learningRows.results as Record<string, unknown>[]) {
    const user = ensureUser(row); const count = Number(row.event_count);
    user.learningEvents += count; user.activities.add(`learning.${String(row.activity_type)}`);
  }
  for (const row of attemptRows.results as Record<string, unknown>[]) {
    const user = ensureUser(row); const count = Number(row.event_count);
    user.assessmentAttempts += count; user.activities.add("assessment.submitted");
  }
  for (const row of mcpRows.results as Record<string, unknown>[]) {
    const user = ensureUser(row); const count = Number(row.event_count);
    user.mcpCalls += count; user.activities.add(`ai.${String(row.tool_name)}`);
    if (!Number(row.succeeded)) user.rejectedActions += count;
  }
  for (const row of orderRows.results as Record<string, unknown>[]) {
    const user = ensureUser(row); const count = Number(row.event_count);
    user.orders += count; user.activities.add(`order.${String(row.status)}`);
  }
  const failure = (operational.results[0] ?? {}) as Record<string, unknown>;
  const serverErrors = Number(failure.failed_webhooks ?? 0) + Number(failure.failed_orders ?? 0)
    + Number(failure.failed_settlements ?? 0) + Number(failure.earning_errors ?? 0);
  return {
    period: window.period, timezone: "Asia/Singapore", periodStart: window.start, periodEnd: window.end,
    generatedAt: new Date().toISOString(),
    summary: {
      activeUsers: users.size, signedIns, newUsers: Number(failure.new_users ?? 0),
      recordedEvents: [...users.values()].reduce((sum, user) => sum + user.auditEvents + user.learningEvents + user.assessmentAttempts + user.mcpCalls + user.orders, 0),
      serverErrors, rejectedActions: [...users.values()].reduce((sum, user) => sum + user.rejectedActions, 0)
    },
    errors: {
      failedWebhooks: Number(failure.failed_webhooks ?? 0), failedOrders: Number(failure.failed_orders ?? 0),
      failedSettlements: Number(failure.failed_settlements ?? 0), earningErrors: Number(failure.earning_errors ?? 0)
    },
    users: [...users.values()].sort((a, b) => b.lastActive.localeCompare(a.lastActive)).map((user) => ({
      ...user, activities: [...user.activities]
    })),
    locationCoverage: "Country is profile-provided. City and region are not collected or inferred from IP addresses."
  };
}

function adminShell(name: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
  <title>PencilScope System Administration</title><style>
  :root{font-family:system-ui,sans-serif;color:#102a56;background:#eef6ff}*{box-sizing:border-box}body{margin:0}header{padding:20px 28px;display:flex;align-items:center;justify-content:space-between;color:#fff;background:#081f42}header strong{font-size:20px}nav{padding:12px 28px;display:flex;gap:8px;flex-wrap:wrap;background:#fff;border-bottom:1px solid #d7e2f0}nav button{padding:9px 13px;border:0;border-radius:8px;background:#eef6ff;color:#102a56;font-weight:700;cursor:pointer}main{width:min(1240px,calc(100% - 32px));margin:28px auto}.metrics{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}.metric,.panel{padding:20px;border:1px solid #d7e2f0;border-radius:13px;background:#fff}.metric strong{display:block;font-size:30px}.metric span{color:#53677f;font-size:12px}.panel{margin-top:20px;overflow:auto}.panel h2{margin:0 0 14px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:11px;text-align:left;border-bottom:1px solid #d7e2f0;vertical-align:top}th{color:#53677f;font-size:10px;text-transform:uppercase}button.action{padding:7px 10px;border:1px solid #315ea8;border-radius:7px;background:#fff;color:#102a56;cursor:pointer}.danger{border-color:#b44;color:#822}.status{padding:4px 7px;border-radius:99px;background:#eef6ff;font-size:10px}.error{padding:14px;color:#822;background:#ffe9e5;border-radius:10px}.notice{padding:14px;color:#174a36;background:#e8f7ef;border-radius:10px}.composer{display:grid;grid-template-columns:1fr 1fr;gap:16px}.composer label{display:grid;gap:6px;color:#53677f;font-size:12px;font-weight:700}.composer .wide{grid-column:1/-1}.composer input,.composer select,.composer textarea{width:100%;padding:11px;border:1px solid #b9c9dc;border-radius:8px;background:#fff;color:#102a56;font:inherit}.composer textarea{min-height:110px;resize:vertical}.composer button{padding:12px 18px;justify-self:start;border:0;border-radius:8px;color:#fff;background:#1d4ed8;font-weight:700;cursor:pointer}.composer small{font-weight:400}.audience-summary{padding:10px;border-radius:8px;background:#eef6ff}.toolbar{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}.toolbar select{padding:9px;border:1px solid #b9c9dc;border-radius:8px;background:#fff}.detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.detail-grid div,.message-card{padding:13px;border-radius:9px;background:#f6f9fd}.detail-grid small{display:block;color:#53677f}.message-card{margin-top:12px;white-space:pre-wrap}.detail-actions{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}.notes{display:grid;gap:8px}.note{padding:10px;border-left:3px solid #315ea8;background:#f6f9fd}.priority-critical{color:#9b1c1c}.priority-warning{color:#8a5a00}.live-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}.live-title{display:flex;align-items:center;gap:9px}.live-dot{width:9px;height:9px;border-radius:50%;background:#16a36a;box-shadow:0 0 0 4px #dff7ec}.period-actions{display:flex;gap:7px}.period-actions button.active{color:#fff;background:#1d4ed8}.activity-note{color:#53677f;font-size:12px}.activity-list{display:flex;gap:5px;flex-wrap:wrap}.activity-list span{padding:3px 7px;border-radius:99px;background:#eef6ff;font-size:10px}.metric.alert strong{color:#a33}@media(max-width:800px){.metrics{grid-template-columns:1fr 1fr}.composer{grid-template-columns:1fr}.composer .wide{grid-column:auto}}
  </style></head><body><header><strong>PencilScope · System Administration</strong><span>${name}</span></header>
  <nav><button data-view="overview">Overview</button><button data-view="activity">Live activity</button><button data-view="enquiries">Enquiries</button><button data-view="users">Users</button><button data-view="notifications">Notifications</button><button data-view="courses">Courses</button><button data-view="orders">Bookings & payments</button><button data-view="settlements">Creator settlements</button><button data-view="disputes">Disputes</button><button data-view="sessions">Active sessions</button><button data-view="audit">Audit log</button><button data-view="health">Service status</button></nav>
  <main><div id="content">Loading…</div></main><script>
  const out=document.querySelector('#content');
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=(v,c)=>new Intl.NumberFormat('en-SG',{style:'currency',currency:c||'SGD'}).format(Number(v||0)/100);
  const table=(cols,rows)=>'<div class="panel"><table><thead><tr>'+cols.map(c=>'<th>'+esc(c[0])+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+cols.map(c=>'<td>'+c[1](r)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
  const countries=new Intl.DisplayNames(['en'],{type:'region'});
  const activityLabel=value=>{const labels={'session.signed_in':'Signed in','session.signed_out':'Signed out','course.created':'Created course','preferences.language_updated':'Changed language','assessment.submitted':'Submitted assessment','order.paid':'Paid purchase','order.failed':'Failed purchase'};return labels[value]||String(value).replace(/^ai\./,'AI · ').replace(/^learning\./,'Learning · ').replaceAll('_',' ').replaceAll('.',' · ')};
  const activityPanel=(d,compact=false)=>'<section class="panel"><div class="live-heading"><div><div class="live-title"><span class="live-dot"></span><h2>'+esc(d.period==='yesterday'?'Yesterday’s user activity':'Live user activity')+'</h2></div><p class="activity-note">Singapore time · refreshed '+esc(new Date(d.generatedAt).toLocaleString('en-SG',{timeZone:'Asia/Singapore'}))+'</p></div>'+(compact?'<button class="action" data-view="activity">Open live dashboard</button>':'<div class="period-actions"><button class="action '+(d.period==='today'?'active':'')+'" data-activity-period="today">Today</button><button class="action '+(d.period==='yesterday'?'active':'')+'" data-activity-period="yesterday">Yesterday</button><button class="action" data-activity-refresh>Refresh</button></div>')+'</div><div class="metrics"><div class="metric"><strong>'+esc(d.summary.activeUsers)+'</strong><span>Active users</span></div><div class="metric"><strong>'+esc(d.summary.signedIns)+'</strong><span>Sign-ins</span></div><div class="metric"><strong>'+esc(d.summary.recordedEvents)+'</strong><span>Recorded activities</span></div><div class="metric '+(d.summary.serverErrors?'alert':'')+'"><strong>'+esc(d.summary.serverErrors)+'</strong><span>Server errors</span></div><div class="metric"><strong>'+esc(d.summary.rejectedActions)+'</strong><span>Rejected user / AI actions</span></div></div>'+(d.users.length?table([['User',r=>'<strong>'+esc(r.name)+'</strong><br><small>'+esc(r.role)+'</small>'],['Location',r=>esc(r.countryCode?(countries.of(r.countryCode)||r.countryCode):'Not provided')+'<br><small>City not collected</small>'],['Last activity',r=>esc(new Date(r.lastActive).toLocaleString('en-SG',{timeZone:'Asia/Singapore'}))],['Activity',r=>'<div class="activity-list">'+r.activities.map(a=>'<span>'+esc(activityLabel(a))+'</span>').join('')+'</div>'],['Totals',r=>esc(r.auditEvents+r.learningEvents+r.assessmentAttempts+r.mcpCalls+r.orders)+(r.rejectedActions?'<br><small>'+esc(r.rejectedActions)+' rejected</small>':'')]],d.users):'<p class="activity-note">No signed-in activity was recorded for this period.</p>')+'<p class="activity-note">'+esc(d.locationCoverage)+'</p></section>';
  async function api(path,options){const r=await fetch('/api/admin/'+path,options);const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Request failed');return j}
  async function showEnquiry(id){out.textContent='Loading enquiry…';try{const d=await api('enquiries/'+encodeURIComponent(id)),r=d.enquiry,p=r.payload||{},c=p.contact||{},q=p.enquiry||{},country=c.country||{},phone=c.phone||{};let actions='';if(d.canManage&&r.status==='deleted'&&!r.purged_at)actions='<button class="action" data-enquiry-restore="'+esc(r.id)+'">Restore enquiry</button>';if(d.canManage&&r.status!=='deleted')actions=['new','in_progress','resolved','spam','deleted'].filter(s=>s!==r.status).map(s=>'<button class="action '+(s==='deleted'?'danger':'')+'" data-enquiry-status="'+esc(s)+'" data-enquiry-id="'+esc(r.id)+'">'+esc(s.replaceAll('_',' '))+'</button>').join(' ');out.innerHTML='<button class="action" data-view="enquiries">← Back to enquiries</button><div class="panel"><h1>'+esc(r.reference_code)+'</h1><div class="detail-grid"><div><small>Name</small><strong>'+esc(c.name)+'</strong></div><div><small>Status</small><span class="status">'+esc(r.status.replaceAll('_',' '))+'</span></div><div><small>Country</small>'+esc(country.name)+' ('+esc(country.code)+')</div><div><small>Contact number</small>'+esc(phone.e164)+'</div><div><small>Type</small>'+esc(q.type?.replaceAll('_',' '))+'</div><div><small>Received</small>'+esc(p.submittedAt)+'</div><div><small>Source page</small>'+esc(p.sourcePath)+'</div><div><small>Recovery until</small>'+esc(r.recoverable_until||'—')+'</div></div><div class="message-card"><strong>Message</strong><br>'+esc(q.message)+'</div><div class="detail-actions">'+actions+'</div><h2>Activity notes</h2><div class="notes">'+(d.notes.length?d.notes.map(n=>'<div class="note">'+esc(n.body)+'<br><small>'+esc(n.author_name||'System')+' · '+esc(n.created_at)+'</small></div>').join(''):'<p>No activity notes yet.</p>')+'</div></div>';}catch(e){out.innerHTML='<p class="error">'+esc(e.message)+'</p>'}}
  let currentView='overview',activityPeriod='today';
  async function load(view='overview'){currentView=view.split('?')[0];out.textContent='Loading…';try{const d=await api(view);
    if(view==='overview'){const activity=await api('activity?period=today');out.innerHTML='<div class="metrics">'+[['Users',d.users],['Courses',d.courses],['Paid bookings',d.paidOrders],['Active learners',d.activeLearners],['New enquiries',d.newEnquiries],['Active sessions',d.activeSessions]].map(x=>'<div class="metric"><strong>'+esc(x[1])+'</strong><span>'+esc(x[0])+'</span></div>').join('')+'</div>'+activityPanel(activity,true)}
    if(view.startsWith('activity')){activityPeriod=d.period;out.innerHTML=activityPanel(d)}
    if(view.startsWith('enquiries')){out.innerHTML='<div class="toolbar"><h1>Contact enquiries</h1><label>Status <select data-enquiry-filter><option value="">Open enquiries</option><option value="new">New</option><option value="in_progress">In progress</option><option value="resolved">Resolved</option><option value="spam">Spam</option><option value="deleted">Deleted / recoverable</option></select></label></div>'+table([['Reference',r=>'<strong>'+esc(r.reference_code)+'</strong><br><small>'+esc(r.created_at)+'</small>'],['Contact',r=>esc(r.display_name)+'<br><small>'+esc(r.country_name)+' · ••••'+esc(r.phone_last4)+'</small>'],['Type',r=>esc(r.enquiry_type.replaceAll('_',' '))],['Status',r=>'<span class="status">'+esc(r.status.replaceAll('_',' '))+'</span>'],['Source',r=>esc(r.source_path)],['Action',r=>'<button class="action" data-enquiry="'+esc(r.id)+'">View</button>']],d.enquiries);out.querySelector('[data-enquiry-filter]').value=d.status||''}
    if(view==='users')out.innerHTML='<h1>Users</h1>'+table([['User',r=>'<strong>'+esc(r.display_name)+'</strong><br><small>'+esc(r.email)+'</small>'],['Role',r=>esc(r.role)],['Status',r=>'<span class="status">'+esc(r.status)+'</span>'],['Last login',r=>esc(r.last_login_at||'Never')],['Sessions',r=>esc(r.active_sessions)],['Action',r=>r.status==='active'?'<button class="action danger" data-user="'+esc(r.id)+'" data-status="suspended">Deactivate</button>':'<button class="action" data-user="'+esc(r.id)+'" data-status="active">Activate</button>']],d.users);
    if(view==='notifications')out.innerHTML='<h1>System notifications</h1><p>Send an in-app announcement to every active user or a selected audience. Only system administrators can publish.</p><form class="panel composer" id="notification-composer"><label>Title<input name="title" required minlength="2" maxlength="120" placeholder="Scheduled maintenance"></label><label>Priority<select name="priority"><option value="info">Information</option><option value="important">Important</option><option value="warning">Warning</option><option value="critical">Critical</option></select></label><label class="wide">Message<textarea name="body" required minlength="2" maxlength="2000" placeholder="Write a clear, concise update."></textarea></label><label>Category<select name="category"><option value="system">System</option><option value="learning">Learning</option><option value="creator">Creator</option><option value="billing">Billing</option><option value="security">Security</option></select></label><label>Audience<select name="audienceType" id="notification-audience"><option value="all">All active users</option><option value="learners">Active learners</option><option value="creators">Content creators</option><option value="specific_users">Specific users by email</option><option value="country">Users in a country</option><option value="interest">Users with an interest</option></select></label><label class="wide" id="audience-value-label">Audience value<textarea name="audienceValue" maxlength="10000" placeholder="Only required for email, country or interest targeting"></textarea><small id="audience-help">No value is needed when sending to all active users.</small></label><label>Action label<input name="actionLabel" maxlength="40" placeholder="View details"></label><label>Action URL<input name="actionUrl" maxlength="500" placeholder="/dashboard"><small>Use a PencilScope path beginning with /.</small></label><label>Expires at<input name="expiresAt" type="datetime-local"></label><div class="wide audience-summary">The recipient count will be validated before publication. Sending creates an immutable, audited campaign.</div><button type="submit">Publish notification</button><p id="notification-result"></p></form><h2>Campaign history</h2>'+table([['Notification',r=>'<strong>'+esc(r.title)+'</strong><br><small>'+esc(r.category)+' · '+esc(r.audience_type)+'</small>'],['Priority',r=>'<span class="priority-'+esc(r.priority)+'">'+esc(r.priority)+'</span>'],['Recipients',r=>esc(r.recipient_count)],['Read',r=>esc(r.read_count)],['Clicked',r=>esc(r.clicked_count)],['Published',r=>esc(r.published_at)]],d.campaigns);
    if(view==='courses')out.innerHTML='<h1>Courses</h1>'+table([['Course',r=>'<strong>'+esc(r.title)+'</strong><br><small>'+esc(r.creator_name)+'</small>'],['State',r=>esc(r.status)+' · '+esc(r.listing_status)],['Bookings',r=>esc(r.booking_count)],['Learners',r=>esc(r.learner_count)],['Gross',r=>money(r.gross_cents,r.currency)]],d.courses);
    if(view==='orders')out.innerHTML='<h1>Bookings and payments</h1>'+table([['Order',r=>esc(r.id)],['Learner',r=>'<strong>'+esc(r.learner_name)+'</strong><br><small>'+esc(r.learner_email)+'</small>'],['Course',r=>esc(r.course_title)+'<br><small>'+esc(r.offering_title||'')+'</small>'],['Status',r=>esc(r.status)],['Amount',r=>money(r.amount_cents,r.currency)],['Date',r=>esc(r.created_at)]],d.orders);
    if(view==='settlements')out.innerHTML='<h1>Creator settlements</h1>'+table([['Creator',r=>'<strong>'+esc(r.creator_name)+'</strong><br><small>'+esc(r.creator_email)+'</small>'],['Course',r=>esc(r.course_title)+'<br><small>'+esc(r.offering_title||'')+'</small>'],['Gross',r=>money(r.gross_cents,r.currency)],['Net payout',r=>'<strong>'+money(r.payable_cents,r.currency)+'</strong>'],['Status',r=>'<span class="status">'+esc(r.status.replaceAll('_',' '))+'</span>'],['Review ends',r=>esc(r.review_ends_at||'—')]],d.settlements);
    if(view==='disputes')out.innerHTML='<h1>Disputes and learner issues</h1>'+table([['Learner',r=>'<strong>'+esc(r.learner_name)+'</strong><br><small>'+esc(r.learner_email)+'</small>'],['Course',r=>esc(r.course_title)],['Type',r=>esc(r.case_type.replaceAll('_',' '))],['Reason',r=>esc(r.reason)],['Status',r=>'<span class="status">'+esc(r.status)+'</span>'],['Opened',r=>esc(r.opened_at)],['Action',r=>['open','reviewing'].includes(r.status)?'<button class="action" data-case="'+esc(r.id)+'" data-case-status="resolved">Resolve</button> <button class="action danger" data-case="'+esc(r.id)+'" data-case-status="rejected">Reject</button>':'—']],d.disputes);
    if(view==='sessions')out.innerHTML='<h1>Active sessions</h1>'+table([['User',r=>'<strong>'+esc(r.display_name)+'</strong><br><small>'+esc(r.email)+'</small>'],['Started',r=>esc(r.created_at)],['Last seen',r=>esc(r.last_seen_at)],['Expires',r=>esc(r.expires_at)]],d.sessions);
    if(view==='audit')out.innerHTML='<h1>Audit log</h1>'+table([['Time',r=>esc(r.created_at)],['Actor',r=>esc(r.actor_name||'System')],['Action',r=>esc(r.action)],['Target',r=>esc(r.entity_type)+' · '+esc(r.entity_id||'')],['Metadata',r=>'<code>'+esc(r.metadata_json)+'</code>']],d.events);
    if(view==='health')out.innerHTML='<h1>Service status</h1><div class="metrics"><div class="metric"><strong>'+esc(d.core.status)+'</strong><span>Core API</span></div><div class="metric"><strong>'+esc(d.database)+'</strong><span>Database</span></div><div class="metric"><strong>'+esc(d.failedWebhooks)+'</strong><span>Failed webhooks</span></div><div class="metric"><strong>'+esc(d.lastWebhook||'—')+'</strong><span>Last webhook</span></div></div>';
  }catch(e){out.innerHTML='<p class="error">'+esc(e.message)+'</p>'}}
  document.addEventListener('click',e=>{const b=e.target.closest('[data-view]');if(b)load(b.dataset.view)});
  document.addEventListener('click',e=>{const b=e.target.closest('[data-activity-period]');if(b)load('activity?period='+encodeURIComponent(b.dataset.activityPeriod))});
  document.addEventListener('click',e=>{if(e.target.closest('[data-activity-refresh]'))load('activity?period='+encodeURIComponent(activityPeriod))});
  document.addEventListener('click',e=>{const b=e.target.closest('[data-enquiry]');if(b)showEnquiry(b.dataset.enquiry)});
  document.addEventListener('change',e=>{if(e.target.matches('[data-enquiry-filter]'))load('enquiries'+(e.target.value?'?status='+encodeURIComponent(e.target.value):''))});
  document.addEventListener('click',async e=>{const b=e.target.closest('[data-enquiry-status]');if(!b)return;const status=b.dataset.enquiryStatus;if(status==='deleted'&&!confirm('Delete this enquiry? It can be restored for seven days.'))return;const note=prompt('Add an activity note for this change:');if(!note)return;await api('enquiries/'+encodeURIComponent(b.dataset.enquiryId)+'/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status,note})});status==='deleted'?load('enquiries'):showEnquiry(b.dataset.enquiryId)});
  document.addEventListener('click',async e=>{const b=e.target.closest('[data-enquiry-restore]');if(!b)return;await api('enquiries/'+encodeURIComponent(b.dataset.enquiryRestore)+'/restore',{method:'POST'});showEnquiry(b.dataset.enquiryRestore)});
  document.addEventListener('click',async e=>{const b=e.target.closest('[data-user]');if(!b)return;const reason=prompt('Reason for this access change:');if(!reason)return;await api('users/'+encodeURIComponent(b.dataset.user)+'/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status:b.dataset.status,reason})});load('users')});
  document.addEventListener('click',async e=>{const b=e.target.closest('[data-case]');if(!b)return;const note=prompt('Resolution note (recorded in the audit log):');if(!note)return;await api('disputes/'+encodeURIComponent(b.dataset.case)+'/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status:b.dataset.caseStatus,note})});load('disputes')});
  document.addEventListener('change',e=>{if(e.target.id!=='notification-audience')return;const help=document.querySelector('#audience-help');const hints={all:'No value is needed when sending to all active users.',learners:'No value is needed. Active course and product learners are included.',creators:'No value is needed. Users with saved courses or learning products are included.',specific_users:'Enter email addresses separated by commas, spaces or new lines.',country:'Enter a two-letter country code such as SG.',interest:'Enter the interest category ID shown in the course category records.'};if(help)help.textContent=hints[e.target.value]||''});
  document.addEventListener('submit',async e=>{if(e.target.id!=='notification-composer')return;e.preventDefault();const form=e.target,button=form.querySelector('button[type="submit"]'),result=form.querySelector('#notification-result'),values=Object.fromEntries(new FormData(form));if(values.audienceType==='all'&&!confirm('Send this notification to every active user?'))return;button.disabled=true;result.className='';result.textContent='Publishing…';try{if(values.expiresAt)values.expiresAt=new Date(values.expiresAt).toISOString();const response=await api('notifications',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(values)});result.className='notice';result.textContent='Published to '+response.campaign.recipientCount+' users.';setTimeout(()=>load('notifications'),900)}catch(error){result.className='error';result.textContent=error.message}finally{button.disabled=false}});
  setInterval(()=>{if(currentView==='activity')load('activity?period='+encodeURIComponent(activityPeriod));else if(currentView==='overview')load('overview')},60_000);
  load();</script></body></html>`;
}

export default {
  async fetch(request, env, context): Promise<Response> {
    const ctx = context as AccessContext;
    const actor = await authorize(request, env, ctx);
    if (!actor) return request.url.includes("/api/") ? json({ error: "Access denied." }, 403) : html("<h1>Access denied</h1>", 403);
    const url = new URL(request.url);
    if (url.pathname === "/") return html(adminShell(actor.display_name));
    if (!url.pathname.startsWith("/api/admin/")) return json({ error: "Not found." }, 404);
    const route = url.pathname.slice("/api/admin/".length);

    if (request.method === "GET" && route === "activity") {
      return json(await activitySnapshot(env, url.searchParams.get("period") ?? "today"));
    }
    if (request.method === "GET" && route === "overview") {
      const [users, courses, paidOrders, learners, sessions, newEnquiries] = await env.DB.batch([
        env.DB.prepare("SELECT COUNT(*) AS total FROM users"),
        env.DB.prepare("SELECT COUNT(*) AS total FROM courses"),
        env.DB.prepare("SELECT COUNT(*) AS total FROM orders WHERE status = 'paid'"),
        env.DB.prepare("SELECT COUNT(DISTINCT student_user_id) AS total FROM enrolment_offerings WHERE status = 'active'"),
        env.DB.prepare("SELECT COUNT(*) AS total FROM user_sessions WHERE revoked_at IS NULL AND expires_at > ? AND last_seen_at > ?")
          .bind(new Date().toISOString(), new Date(Date.now() - 30 * 60_000).toISOString()),
        env.DB.prepare("SELECT COUNT(*) AS total FROM contact_enquiries WHERE status = 'new'")
      ]);
      return json({
        users: total(users), courses: total(courses),
        paidOrders: total(paidOrders), activeLearners: total(learners),
        activeSessions: total(sessions), newEnquiries: total(newEnquiries)
      });
    }
    if (request.method === "GET" && route === "enquiries") {
      await purgeExpiredEnquiries(env);
      const requestedStatus = url.searchParams.get("status") ?? "";
      const statuses = new Set(["new", "in_progress", "resolved", "spam", "deleted"]);
      const status = statuses.has(requestedStatus) ? requestedStatus : "";
      const result = status
        ? await env.DB.prepare(
            `SELECT id, reference_code, display_name, country_code, country_name, enquiry_type,
              phone_last4, source_path, status, created_at, updated_at, recoverable_until, purged_at
             FROM contact_enquiries WHERE status = ? ORDER BY created_at DESC LIMIT 500`
          ).bind(status).all()
        : await env.DB.prepare(
            `SELECT id, reference_code, display_name, country_code, country_name, enquiry_type,
              phone_last4, source_path, status, created_at, updated_at, recoverable_until, purged_at
             FROM contact_enquiries WHERE status <> 'deleted' ORDER BY created_at DESC LIMIT 500`
          ).all();
      return json({ enquiries: result.results, canManage: actor.role !== "auditor", status });
    }

    const enquiryDetail = route.match(/^enquiries\/([^/]+)$/);
    if (request.method === "GET" && enquiryDetail) {
      const enquiryId = decodeURIComponent(enquiryDetail[1]);
      const row = await env.DB.prepare(
        "SELECT * FROM contact_enquiries WHERE id = ?"
      ).bind(enquiryId).first<ContactCatalogueRow>();
      if (!row) return json({ error: "Enquiry not found." }, 404);
      if (row.purged_at) return json({ error: "This enquiry has passed its recovery period and its private content was purged." }, 410);
      const object = await env.CONTACT_ENQUIRIES.get(row.object_key);
      if (!object) return json({ error: "The enquiry content is unavailable." }, 503);
      const serialized = await object.text();
      if (await digestHex(serialized) !== row.checksum_sha256) {
        return json({ error: "The enquiry content failed its integrity check." }, 503);
      }
      const notes = await env.DB.prepare(
        `SELECT n.id, n.body, n.created_at, u.display_name AS author_name
         FROM contact_enquiry_notes n LEFT JOIN users u ON u.id = n.author_user_id
         WHERE n.enquiry_id = ? ORDER BY n.created_at DESC`
      ).bind(enquiryId).all();
      await audit(env, actor.id, "contact_enquiry.viewed", enquiryId,
        { referenceCode: row.reference_code }, "contact_enquiry");
      return json({
        enquiry: { ...row, payload: JSON.parse(serialized), object_key: undefined, checksum_sha256: undefined },
        notes: notes.results,
        canManage: actor.role !== "auditor"
      });
    }

    const enquiryRestore = route.match(/^enquiries\/([^/]+)\/restore$/);
    if (request.method === "POST" && enquiryRestore) {
      if (actor.role === "auditor") return json({ error: "Read-only auditor access cannot change enquiries." }, 403);
      const enquiryId = decodeURIComponent(enquiryRestore[1]);
      const row = await env.DB.prepare(
        "SELECT id, reference_code, object_key, status, recoverable_until, purged_at FROM contact_enquiries WHERE id = ?"
      ).bind(enquiryId).first<ContactCatalogueRow>();
      if (!row) return json({ error: "Enquiry not found." }, 404);
      if (row.status !== "deleted" || row.purged_at || !row.recoverable_until || Date.parse(row.recoverable_until) <= Date.now()) {
        return json({ error: "This enquiry can no longer be restored." }, 409);
      }
      if (!await env.CONTACT_ENQUIRIES.head(row.object_key)) {
        return json({ error: "The enquiry content is unavailable." }, 409);
      }
      const now = new Date().toISOString();
      await env.DB.prepare(
        `UPDATE contact_enquiries SET status = 'new', deleted_at = NULL, recoverable_until = NULL,
         updated_at = ? WHERE id = ?`
      ).bind(now, enquiryId).run();
      await audit(env, actor.id, "contact_enquiry.restored", enquiryId,
        { referenceCode: row.reference_code }, "contact_enquiry");
      return json({ enquiry: { id: enquiryId, status: "new" } });
    }

    const enquiryStatus = route.match(/^enquiries\/([^/]+)\/status$/);
    if (request.method === "POST" && enquiryStatus) {
      if (actor.role === "auditor") return json({ error: "Read-only auditor access cannot change enquiries." }, 403);
      const enquiryId = decodeURIComponent(enquiryStatus[1]);
      let input: { status?: unknown; note?: unknown };
      try { input = await request.json(); } catch { return json({ error: "A JSON body is required." }, 400); }
      const status = typeof input.status === "string" && ["new", "in_progress", "resolved", "spam", "deleted"].includes(input.status)
        ? input.status : "";
      const note = typeof input.note === "string" ? input.note.trim().slice(0, 1000) : "";
      if (!status || note.length < 3) return json({ error: "A valid status and note are required." }, 400);
      const row = await env.DB.prepare(
        "SELECT id, reference_code, status, purged_at FROM contact_enquiries WHERE id = ?"
      ).bind(enquiryId).first<ContactCatalogueRow>();
      if (!row) return json({ error: "Enquiry not found." }, 404);
      if (row.purged_at) return json({ error: "Purged enquiries cannot be changed." }, 409);
      if (row.status === "deleted") return json({ error: "Restore this enquiry before changing its status." }, 409);
      const now = new Date();
      const nowIso = now.toISOString();
      const deletedAt = status === "deleted" ? nowIso : null;
      const recoverableUntil = status === "deleted" ? new Date(now.getTime() + 7 * 86_400_000).toISOString() : null;
      const resolvedAt = status === "resolved" ? nowIso : null;
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE contact_enquiries SET status = ?, resolved_at = ?, deleted_at = ?,
           recoverable_until = ?, updated_at = ? WHERE id = ?`
        ).bind(status, resolvedAt, deletedAt, recoverableUntil, nowIso, enquiryId),
        env.DB.prepare(
          `INSERT INTO contact_enquiry_notes (id, enquiry_id, author_user_id, body, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(crypto.randomUUID(), enquiryId, actor.id, note, nowIso)
      ]);
      await audit(env, actor.id, "contact_enquiry.status_changed", enquiryId,
        { from: row.status, to: status, note, recoverableUntil }, "contact_enquiry");
      return json({ enquiry: { id: enquiryId, status, recoverableUntil } });
    }

    if (request.method === "GET" && route === "users") {
      const result = await env.DB.prepare(
        `SELECT u.id, u.email, u.display_name, u.role, u.status, u.created_at,
          uc.last_login_at,
          (SELECT COUNT(*) FROM user_sessions s WHERE s.user_id = u.id
           AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_sessions
         FROM users u LEFT JOIN user_credentials uc ON uc.user_id = u.id
         ORDER BY u.created_at DESC LIMIT 1000`
      ).bind(new Date().toISOString()).all();
      return json({ users: result.results });
    }
    if (request.method === "GET" && route === "notifications") {
      const campaigns = await env.DB.prepare(
        `SELECT c.*,
          (SELECT COUNT(*) FROM in_app_notifications n WHERE n.campaign_id = c.id AND n.read_at IS NOT NULL) AS read_count,
          (SELECT COUNT(*) FROM in_app_notifications n WHERE n.campaign_id = c.id AND n.clicked_at IS NOT NULL) AS clicked_count
         FROM notification_campaigns c ORDER BY c.created_at DESC LIMIT 250`
      ).all();
      return json({ campaigns: campaigns.results });
    }
    if (request.method === "POST" && route === "notifications") {
      if (actor.role !== "system_admin") return json({ error: "System administrator access is required." }, 403);
      let input: Record<string, unknown>;
      try { input = await request.json(); } catch { return json({ error: "A JSON body is required." }, 400); }
      const clean = (value: unknown, maximum: number) => typeof value === "string" ? value.trim().slice(0, maximum) : "";
      const title = clean(input.title, 120);
      const body = clean(input.body, 2000);
      const category = ["system", "learning", "creator", "social", "billing", "security"].includes(String(input.category)) ? String(input.category) : "system";
      const priority = ["info", "important", "warning", "critical"].includes(String(input.priority)) ? String(input.priority) : "info";
      const audienceType = ["all", "learners", "creators", "specific_users", "country", "interest"].includes(String(input.audienceType)) ? String(input.audienceType) : "";
      const audienceValue = clean(input.audienceValue, 10000);
      const actionUrl = clean(input.actionUrl, 500);
      const actionLabel = clean(input.actionLabel, 40);
      const expiresAt = clean(input.expiresAt, 40);
      if (title.length < 2 || body.length < 2 || !audienceType) return json({ error: "Title, message and a valid audience are required." }, 400);
      if (actionUrl && !/^\/(?!\/)/.test(actionUrl)) return json({ error: "The action URL must be a PencilScope path beginning with /." }, 400);
      if (actionLabel && !actionUrl) return json({ error: "An action URL is required when an action label is provided." }, 400);
      if (expiresAt && (Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) return json({ error: "The expiry must be a future date." }, 400);

      let predicate = "1 = 1";
      let bindings: unknown[] = [];
      let audience: Record<string, unknown> = {};
      if (audienceType === "learners") predicate = "EXISTS (SELECT 1 FROM enrolment_offerings eo WHERE eo.student_user_id = u.id AND eo.status = 'active') OR EXISTS (SELECT 1 FROM learning_product_entitlements le WHERE le.user_id = u.id AND le.status = 'active')";
      if (audienceType === "creators") predicate = "EXISTS (SELECT 1 FROM courses c WHERE c.tutor_id = u.id) OR EXISTS (SELECT 1 FROM learning_products p WHERE p.creator_id = u.id)";
      if (audienceType === "specific_users") {
        const emails = [...new Set(audienceValue.toLowerCase().split(/[\s,;]+/).filter(Boolean))].slice(0, 500);
        if (!emails.length || emails.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return json({ error: "Provide valid user email addresses." }, 400);
        predicate = `LOWER(u.email) IN (${emails.map(() => "?").join(",")})`;
        bindings = emails;
        audience = { emails };
      }
      if (audienceType === "country") {
        const country = audienceValue.toUpperCase();
        if (!/^[A-Z]{2}$/.test(country)) return json({ error: "Provide a two-letter country code." }, 400);
        predicate = "ap.country_code = ?"; bindings = [country]; audience = { country };
      }
      if (audienceType === "interest") {
        if (!audienceValue || audienceValue.length > 100) return json({ error: "Provide a valid interest category ID." }, 400);
        predicate = "EXISTS (SELECT 1 FROM user_interest_categories ui WHERE ui.user_id = u.id AND ui.category_id = ?)";
        bindings = [audienceValue]; audience = { categoryId: audienceValue };
      }

      const fromAndWhere = `FROM users u LEFT JOIN account_profiles ap ON ap.user_id = u.id WHERE u.status = 'active' AND (${predicate})`;
      const recipient = await env.DB.prepare(`SELECT COUNT(DISTINCT u.id) AS total ${fromAndWhere}`).bind(...bindings).first<{ total: number }>();
      const recipientCount = Number(recipient?.total ?? 0);
      if (!recipientCount) return json({ error: "No active users match this audience." }, 400);
      const campaignId = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO notification_campaigns
            (id, title, body, category, priority, action_url, action_label, audience_type,
             audience_json, status, recipient_count, created_by, created_at, published_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?)`
        ).bind(campaignId, title, body, category, priority, actionUrl || null, actionLabel || null,
          audienceType, JSON.stringify(audience), recipientCount, actor.id, now, now, expiresAt || null),
        env.DB.prepare(
          `INSERT INTO in_app_notifications (id, campaign_id, user_id, delivered_at)
           SELECT lower(hex(randomblob(16))), ?, u.id, ? ${fromAndWhere}`
        ).bind(campaignId, now, ...bindings)
      ]);
      await audit(env, actor.id, "notification.published", campaignId,
        { audienceType, audience, recipientCount, priority, category }, "notification_campaign");
      return json({ campaign: { id: campaignId, recipientCount, status: "published" } }, 201);
    }
    const userStatus = route.match(/^users\/([^/]+)\/status$/);
    if (request.method === "POST" && userStatus) {
      if (actor.role !== "system_admin") return json({ error: "System administrator access is required." }, 403);
      const userId = decodeURIComponent(userStatus[1]);
      const input = await request.json<{ status?: unknown; reason?: unknown }>();
      const status = input.status === "active" ? "active" : input.status === "suspended" ? "suspended" : null;
      const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : "";
      if (!status || reason.length < 3) return json({ error: "A valid status and reason are required." }, 400);
      if (userId === actor.id && status !== "active") return json({ error: "You cannot deactivate your own account." }, 409);
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ?").bind(status, now, userId),
        env.DB.prepare("UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(now, userId)
      ]);
      await audit(env, actor.id, `user.${status === "active" ? "activated" : "deactivated"}`, userId, { reason });
      return json({ user: { id: userId, status } });
    }
    if (request.method === "GET" && route === "courses") {
      const result = await env.DB.prepare(
        `SELECT c.id, c.title, c.status, c.listing_status, c.currency,
          COALESCE(cp.public_name, u.display_name, 'Creator') AS creator_name,
          (SELECT COUNT(*) FROM orders o WHERE o.course_id = c.id) AS booking_count,
          (SELECT COUNT(DISTINCT eo.student_user_id)
             FROM enrolment_offerings eo
             JOIN course_offerings co ON co.id = eo.course_offering_id
            WHERE co.course_id = c.id) AS learner_count,
          (SELECT COALESCE(SUM(o.amount_cents), 0)
             FROM orders o WHERE o.course_id = c.id AND o.status = 'paid') AS gross_cents
         FROM courses c LEFT JOIN users u ON u.id = c.tutor_id
         LEFT JOIN creator_profiles cp ON cp.user_id = c.tutor_id
         ORDER BY c.updated_at DESC LIMIT 1000`
      ).all();
      return json({ courses: result.results });
    }
    if (request.method === "GET" && route === "orders") {
      const result = await env.DB.prepare(
        `SELECT o.*, c.title AS course_title, co.title AS offering_title,
          u.display_name AS learner_name, u.email AS learner_email
         FROM orders o JOIN courses c ON c.id = o.course_id
         LEFT JOIN course_offerings co ON co.id = o.course_offering_id
         JOIN users u ON u.id = o.student_user_id
         ORDER BY o.created_at DESC LIMIT 1000`
      ).all();
      return json({ orders: result.results });
    }
    if (request.method === "GET" && route === "settlements") {
      const result = await env.DB.prepare(
        `SELECT ce.*, c.title AS course_title, co.title AS offering_title,
          u.display_name AS creator_name, u.email AS creator_email
         FROM creator_earnings ce JOIN courses c ON c.id = ce.course_id
         JOIN users u ON u.id = ce.creator_user_id
         LEFT JOIN course_offerings co ON co.id = ce.course_offering_id
         ORDER BY ce.updated_at DESC LIMIT 1000`
      ).all();
      return json({ settlements: result.results });
    }
    if (request.method === "GET" && route === "disputes") {
      const result = await env.DB.prepare(
        `SELECT pc.*, c.title AS course_title, u.display_name AS learner_name,
          u.email AS learner_email FROM learner_payment_cases pc
         JOIN orders o ON o.id = pc.order_id JOIN courses c ON c.id = o.course_id
         JOIN users u ON u.id = o.student_user_id
         ORDER BY CASE pc.status WHEN 'open' THEN 0 WHEN 'reviewing' THEN 1 ELSE 2 END,
          pc.opened_at DESC LIMIT 1000`
      ).all();
      return json({ disputes: result.results });
    }
    const disputeStatus = route.match(/^disputes\/([^/]+)\/status$/);
    if (request.method === "POST" && disputeStatus) {
      if (actor.role !== "system_admin") return json({ error: "System administrator access is required." }, 403);
      const caseId = decodeURIComponent(disputeStatus[1]);
      const input = await request.json<{ status?: unknown; note?: unknown }>();
      const status = input.status === "resolved" ? "resolved" : input.status === "rejected" ? "rejected" : null;
      const note = typeof input.note === "string" ? input.note.trim().slice(0, 1000) : "";
      if (!status || note.length < 3) return json({ error: "A valid outcome and resolution note are required." }, 400);
      const paymentCase = await env.DB.prepare(
        "SELECT id, order_id, status FROM learner_payment_cases WHERE id = ?"
      ).bind(caseId).first<{ id: string; order_id: string; status: string }>();
      if (!paymentCase) return json({ error: "Payment case not found." }, 404);
      if (!["open", "reviewing"].includes(paymentCase.status)) {
        return json({ error: "This payment case is already closed." }, 409);
      }
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE learner_payment_cases SET status = ?, resolution_note = ?,
           resolved_at = ?, updated_at = ? WHERE id = ?`
        ).bind(status, note, now, now, caseId),
        env.DB.prepare(
          `UPDATE creator_earnings SET status = CASE WHEN status = 'held' THEN 'pending_course' ELSE status END,
           updated_at = ? WHERE order_id = ? AND dispute_hold_cents = 0`
        ).bind(now, paymentCase.order_id),
        env.DB.prepare(
          `INSERT INTO audit_logs
            (id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
           VALUES (?, ?, 'payment.case_closed', 'payment_case', ?, ?, ?)`
        ).bind(crypto.randomUUID(), actor.id, caseId, JSON.stringify({ status, note }), now)
      ]);
      return json({ paymentCase: { id: caseId, status } });
    }
    if (request.method === "GET" && route === "sessions") {
      const result = await env.DB.prepare(
        `SELECT s.id, s.created_at, s.last_seen_at, s.expires_at,
          u.display_name, u.email FROM user_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.revoked_at IS NULL AND s.expires_at > ?
         ORDER BY s.last_seen_at DESC LIMIT 1000`
      ).bind(new Date().toISOString()).all();
      return json({ sessions: result.results });
    }
    if (request.method === "GET" && route === "audit") {
      const result = await env.DB.prepare(
        `SELECT al.*, u.display_name AS actor_name FROM audit_logs al
         LEFT JOIN users u ON u.id = al.actor_user_id
         ORDER BY al.created_at DESC LIMIT 1000`
      ).all();
      return json({ events: result.results });
    }
    if (request.method === "GET" && route === "health") {
      let core: Record<string, unknown> = { status: "unavailable" };
      try { core = await (await env.CORE_API.fetch("https://core.internal/api/health")).json(); } catch {}
      const webhook = await env.DB.prepare(
        `SELECT MAX(received_at) AS last_webhook,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM webhook_events`
      ).first<{ last_webhook: string | null; failed: number }>();
      return json({ core, database: "ready", failedWebhooks: webhook?.failed ?? 0, lastWebhook: webhook?.last_webhook });
    }
    return json({ error: "Not found." }, 404);
  }
} satisfies ExportedHandler<Environment>;
