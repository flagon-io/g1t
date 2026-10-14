import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Local-only integration fixture: real built API/Work Workers and D1.
// Authentication, repository lookup and event transport are deterministic
// fixtures. No production credentials or remote service bindings are used.
const root = resolve(import.meta.dirname, '..');
const user = { id: 'usr_test', username: 'tester', verified: true, workspaces: [] };
const repo = { id: 'rep_test', namespace: 'tester', name: 'rehearsal', description: null, isPrivate: false, ownerId: user.id, defaultBranch: 'main', forkOf: null, createdAt: '2026-10-14T00:00:00Z' };
const stub = `const user=${JSON.stringify(user)}; const repo=${JSON.stringify(repo)};
export default { async fetch(request) {
 const method = new URL(request.url).pathname.split('/').pop();
 const body = await request.json();
 if (method === 'user_for_access_token') return Response.json(body.token === 'local-rehearsal' ? user : body.token === 'local-other' ? {...user,id:'usr_other',username:'other'} : null);
 if (method === 'get') return Response.json({ok:true,value:repo});
 if (method === 'publish') return Response.json(null);
 if (method === 'audit_record') return Response.json(1);
 if (method === 'resolve_slug' || method === 'resolve_path') return Response.json(null);
 if (method === 'display_usernames') return Response.json({});
 console.error('Unimplemented local fixture RPC: '+method); return new Response('Unimplemented local fixture RPC: '+method,{status:500});
}};`;
const serviceNames = ['IDENTITY','REPOS','EVENTS','RUNNER','BILLING','INTEGRATIONS','WEBHOOKS','ACTIONS','SEARCH','SECURITY','PROJECTS','DEPLOYMENTS','TELEMETRY','PACKAGES','ARTIFACTS'];
const bindings = Object.fromEntries(serviceNames.map(name => [name, 'fixture']));
const worker = (name, path, extra) => ({ name, modules: [{type:'ESModule',path:resolve(root,path,'build/index.js')},{type:'CompiledWasm',path:resolve(root,path,'build/index_bg.wasm')}], compatibilityDate:'2026-09-26', ...extra });
export async function startLocal({ port = 8799, persist = false } = {}) {
 const mf = new Miniflare(convertV4MiniflareOptions({ host:'127.0.0.1', port, resourcePersistencePath: persist || undefined, workers:[
  worker('api','apps/api',{serviceBindings:{...bindings,WORK:'work'}, bindings:{MCP_URL:`http://127.0.0.1:${port}/mcp`,API_URL:`http://127.0.0.1:${port}`,SITE_URL:`http://127.0.0.1:${port}`}}),
  worker('work','services/work',{serviceBindings:bindings,d1Databases:{DB:'local-coordination'}}),
  {name:'fixture',modules:true,script:stub,compatibilityDate:'2026-09-26'}
 ]}));
 const ready = await mf.ready;
 const db = await mf.getD1Database('DB','work');
 const initialized = await db.prepare("SELECT name FROM sqlite_master WHERE name = 'sessions'").first();
 if (!initialized) {
  for (const file of readdirSync(resolve(root,'services/work/migrations')).filter(f=>f.endsWith('.sql')).sort()) {
   try {
    // These migrations contain no triggers. Keep each complete statement on
    // one line for D1.exec, whose API treats newlines as statement boundaries.
    const sql = readFileSync(resolve(root,'services/work/migrations',file),'utf8')
      .replace(/--[^\n]*/g,'').replace(/\r?\n/g,' ').split(';').map(s=>s.trim()).filter(Boolean).join(';\n');
    await db.exec(sql);
   }
   catch(error) { await mf.dispose(); throw new Error(`${file}: ${error.message}`); }
  }
 }
 return {mf, db, url:ready.origin};
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
 const {mf,url} = await startLocal({persist:resolve(root,'target/submission-audit/local-coordination')});
 console.log(`Local rehearsal ready: ${url}; MCP: ${url}/mcp; token: local-rehearsal (fixture only)`);
 for (const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{await mf.dispose();process.exit(0);});
}
