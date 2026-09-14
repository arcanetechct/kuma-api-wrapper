import { workflow, node, trigger, sticky, placeholder, newCredential, ifElse, merge, splitInBatches, nextBatch, expr } from '@n8n/workflow-sdk';

const scheduleTrig = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.4,
  config: { name: 'Every 30 Min Trigger', parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 30 }] } }, position: [208, 288] },
  output: [{}]
});

const manualTrig = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Manual Trigger', position: [208, 672] },
  output: [{}]
});

const configNode = node({
  type: 'n8n-nodes-base.set',
  version: 3.5,
  config: {
    name: 'Config',
    parameters: {
      assignments: {
        assignments: [
          { id: 'cfg-1', name: 'kuma_bridge_base_url', value: placeholder('Your kuma-ploi-bridge URL, e.g. https://kuma-bridge.arcanetechct.com (no trailing slash)'), type: 'string' },
          { id: 'cfg-2', name: 'excluded_domains', value: '', type: 'string' },
          { id: 'cfg-3', name: 'monitor_interval_seconds', value: 60, type: 'number' }
        ]
      },
      options: {}
    },
    position: [432, 432]
  },
  output: [{ kuma_bridge_base_url: 'https://kuma-bridge.arcanetechct.com', excluded_domains: '', monitor_interval_seconds: 60 }]
});

const ploiListServers = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Ploi: List Servers',
    parameters: {
      url: 'https://ploi.io/api/servers',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpBearerAuth',
      sendQuery: true,
      queryParameters: { parameters: [{ name: 'per_page', value: '100' }] },
      options: {}
    },
    position: [656, 240],
    credentials: { httpBearerAuth: newCredential('Ploi.io') }
  },
  output: [{ data: [{ id: 120528, name: 'ats-ovhva-sw-adler', status: 'active', ip_address: '40.160.84.135' }] }]
});

const extractServerIds = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Extract Server IDs',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: "const resp = $input.first().json;\nconst servers = Array.isArray(resp) ? resp : (resp.data || []);\nconst results = [];\nfor (const server of servers) {\n  results.push({ json: { id: server.id } });\n}\nreturn results;"
    },
    position: [880, 240]
  },
  output: [{ id: 120528 }]
});

const ploiListSites = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Ploi: List Sites',
    parameters: {
      url: expr('https://ploi.io/api/servers/{{ $json.id }}/sites'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpBearerAuth',
      sendQuery: true,
      queryParameters: { parameters: [{ name: 'per_page', value: '100' }] },
      options: {}
    },
    position: [1104, 240],
    credentials: { httpBearerAuth: newCredential('Ploi.io') }
  },
  output: [{ data: [{ id: 1, domain: 'example.com', status: 'active', server_id: 120528, project_type: 'wordpress' }] }]
});

const bridgeGetMonitors = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Bridge: Get Monitors',
    parameters: {
      url: expr('{{ $("Config").item.json.kuma_bridge_base_url }}/monitors'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      options: {}
    },
    position: [656, 528],
    credentials: { httpHeaderAuth: newCredential('Kuma Bridge') }
  },
  output: [{ id: 1, name: 'existing.example.com', type: 'http', url: 'https://existing.example.com', hostname: null }]
});

const combineLists = merge({
  version: 3.2,
  config: { name: 'Combine Lists', parameters: { mode: 'combine', combineBy: 'combineByPosition' }, position: [1328, 384] }
});

const computeItemsToAdd = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Compute Items To Add',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: "const ploiSiteItems = $('Ploi: List Sites').all();\nlet ploiSites = [];\nfor (const item of ploiSiteItems) {\n  const resp = item.json;\n  const arr = Array.isArray(resp) ? resp : (resp.data || []);\n  ploiSites = ploiSites.concat(arr);\n}\n\nconst serversResp = $('Ploi: List Servers').first().json;\nconst ploiServers = Array.isArray(serversResp) ? serversResp : (serversResp.data || []);\n\nconst monitorsResp = $('Bridge: Get Monitors').first().json;\nconst monitors = Array.isArray(monitorsResp) ? monitorsResp : [];\n\nfunction normalizeDomain(raw) {\n  if (!raw) return '';\n  let d = String(raw).trim().toLowerCase();\n  d = d.replace(/^https?:\\/\\//, '');\n  d = d.replace(/^www\\./, '');\n  d = d.replace(/\\/.*$/, '');\n  return d;\n}\n\nconst monitoredDomains = new Set();\nconst monitoredHosts = new Set();\nfor (const m of monitors) {\n  if (m.type === 'http' && m.url) monitoredDomains.add(normalizeDomain(m.url));\n  if ((m.type === 'ping' || m.type === 'port') && m.hostname) monitoredHosts.add(String(m.hostname).trim());\n}\n\nconst excludedRaw = $('Config').first().json.excluded_domains || '';\nconst excludedDomains = new Set(\n  excludedRaw.split(',').map((d) => normalizeDomain(d)).filter((d) => d)\n);\n\nconsole.log('--- Compute Items To Add ---');\nconsole.log('Ploi sites seen: ' + ploiSites.length + ' | Ploi servers seen: ' + ploiServers.length + ' | Existing Kuma monitors: ' + monitors.length);\n\nconst results = [];\n\nfor (const site of ploiSites) {\n  const normalized = normalizeDomain(site.domain);\n\n  if (site.status !== 'active') {\n    console.log('SKIP site ' + site.domain + ': status is \"' + site.status + '\"');\n    continue;\n  }\n  if (!normalized) {\n    console.log('SKIP site (ploi id ' + site.id + '): no domain set');\n    continue;\n  }\n  if (excludedDomains.has(normalized)) {\n    console.log('SKIP site ' + site.domain + ': matches excluded_domains');\n    continue;\n  }\n  if (monitoredDomains.has(normalized)) {\n    console.log('SKIP site ' + site.domain + ': already monitored in Kuma');\n    continue;\n  }\n\n  console.log('ADD site monitor: ' + site.domain);\n  results.push({ json: { kind: 'site', name: site.domain, url: 'https://' + site.domain } });\n}\n\nfor (const server of ploiServers) {\n  if (server.status !== 'active') {\n    console.log('SKIP server ' + server.name + ': status is \"' + server.status + '\"');\n    continue;\n  }\n  const ip = server.ip_address;\n  if (!ip) {\n    console.log('SKIP server ' + server.name + ' (id ' + server.id + '): no ip_address');\n    continue;\n  }\n  if (monitoredHosts.has(String(ip).trim())) {\n    console.log('SKIP server ' + server.name + ': already monitored in Kuma');\n    continue;\n  }\n\n  console.log('ADD server monitor: ' + server.name + ' (' + ip + ')');\n  results.push({ json: { kind: 'server', name: server.name, hostname: ip } });\n}\n\nconsole.log('--- Result: ' + results.length + ' item(s) to add ---');\n\nreturn results;"
    },
    position: [1552, 384]
  },
  output: [{ kind: 'site', name: 'newsite.example.com', url: 'https://newsite.example.com' }]
});

const processOneAtATime = splitInBatches({
  version: 3,
  config: { name: 'Process One At A Time', parameters: { batchSize: 1 }, position: [1776, 384] }
});

const syncComplete = node({
  type: 'n8n-nodes-base.set',
  version: 3.5,
  config: {
    name: 'Sync Complete',
    parameters: { assignments: { assignments: [{ id: 'sum-1', name: 'status', value: 'Kuma sync finished', type: 'string' }] }, options: {} },
    position: [2224, 288]
  },
  output: [{ status: 'Kuma sync finished' }]
});

const routeByKind = ifElse({
  version: 2.3,
  config: {
    name: 'Is Site Or Server?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{ leftValue: expr('{{ $json.kind }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'site' }],
        combinator: 'and'
      },
      options: {}
    },
    position: [2000, 480]
  }
});

const bridgeAddSiteMonitor = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Bridge: Add Site Monitor',
    parameters: {
      method: 'POST',
      url: expr('{{ $("Config").item.json.kuma_bridge_base_url }}/monitors'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ { "type": "http", "name": $json.name, "url": $json.url, "interval": $("Config").item.json.monitor_interval_seconds } }}'),
      options: {}
    },
    onError: 'continueErrorOutput',
    position: [2224, 384],
    credentials: { httpHeaderAuth: newCredential('Kuma Bridge') }
  },
  output: [{ ok: true, monitorID: 42 }]
});

const bridgeAddServerMonitor = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Bridge: Add Server Monitor',
    parameters: {
      method: 'POST',
      url: expr('{{ $("Config").item.json.kuma_bridge_base_url }}/monitors'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ { "type": "ping", "name": $json.name, "hostname": $json.hostname, "interval": $("Config").item.json.monitor_interval_seconds } }}'),
      options: {}
    },
    onError: 'continueErrorOutput',
    position: [2224, 592],
    credentials: { httpHeaderAuth: newCredential('Kuma Bridge') }
  },
  output: [{ ok: true, monitorID: 43 }]
});

const addSiteMonitorFailed = node({
  type: 'n8n-nodes-base.set',
  version: 3.5,
  config: {
    name: 'Add Site Monitor Failed',
    parameters: {
      assignments: {
        assignments: [
          { id: 'fail-1', name: 'name', value: expr('{{ $json.name }}'), type: 'string' },
          { id: 'fail-2', name: 'status', value: 'kuma_add_monitor_failed', type: 'string' },
          { id: 'fail-3', name: 'error_message', value: expr('{{ $json.error || JSON.stringify($json) }}'), type: 'string' }
        ]
      },
      options: {}
    },
    position: [2448, 416]
  },
  output: [{ name: 'failed.example.com', status: 'kuma_add_monitor_failed', error_message: 'Kuma rejected the monitor' }]
});

const addServerMonitorFailed = node({
  type: 'n8n-nodes-base.set',
  version: 3.5,
  config: {
    name: 'Add Server Monitor Failed',
    parameters: {
      assignments: {
        assignments: [
          { id: 'fail-1', name: 'name', value: expr('{{ $json.name }}'), type: 'string' },
          { id: 'fail-2', name: 'status', value: 'kuma_add_monitor_failed', type: 'string' },
          { id: 'fail-3', name: 'error_message', value: expr('{{ $json.error || JSON.stringify($json) }}'), type: 'string' }
        ]
      },
      options: {}
    },
    position: [2448, 688]
  },
  output: [{ name: 'server-01', status: 'kuma_add_monitor_failed', error_message: 'Kuma rejected the monitor' }]
});

const note = sticky(
  '## Ploi -> Uptime Kuma Auto-Monitor\n\n1. Pulls all servers and all active sites from Ploi\n2. Fetches existing monitors from your kuma-ploi-bridge (a small REST wrapper in front of Uptime Kuma\'s Socket.IO API -- see the kuma-ploi-bridge project docs)\n3. For each Ploi site not already monitored by domain: creates an HTTP monitor\n4. For each Ploi server not already monitored by IP: creates a ping monitor\n5. Already-monitored sites/servers are left untouched\n\nRequires: kuma_bridge_base_url set in Config, and a "Kuma Bridge" Header Auth credential (Header Name: Authorization, Value: Bearer <your BRIDGE_API_KEY>).',
  [configNode],
  { color: 5 }
);

export default workflow('ploi-to-uptimekuma-auto-monitor', 'Ploi to Uptime Kuma Auto-Monitor')
  .add(scheduleTrig)
  .to(configNode)
  .add(manualTrig)
  .to(configNode)
  .add(configNode)
  .to(ploiListServers.to(extractServerIds.to(ploiListSites.to(combineLists.input(0)))))
  .add(configNode)
  .to(bridgeGetMonitors.to(combineLists.input(1)))
  .add(combineLists)
  .to(computeItemsToAdd)
  .to(processOneAtATime
    .onDone(syncComplete)
    .onEachBatch(routeByKind
      .onTrue(bridgeAddSiteMonitor
        .onError(addSiteMonitorFailed.to(nextBatch(processOneAtATime)))
        .to(nextBatch(processOneAtATime)))
      .onFalse(bridgeAddServerMonitor
        .onError(addServerMonitorFailed.to(nextBatch(processOneAtATime)))
        .to(nextBatch(processOneAtATime)))))
  .add(note);
