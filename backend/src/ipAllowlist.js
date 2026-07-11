// IP-based access restriction at the backend level (an extra layer alongside nginx).
// Supports single IPs and CIDR subnets (IPv4/IPv6).
import ipaddr from 'ipaddr.js';
import { config } from './config.js';

// Compile a list of textual entries ("1.2.3.4" or "10.0.0.0/8") into matchers.
export function parseAllowed(list) {
  return list.map(entry => {
    if (entry.includes('/')) {
      const [addr, prefix] = entry.split('/');
      return { type: 'cidr', range: [ipaddr.parse(addr), parseInt(prefix, 10)] };
    }
    return { type: 'ip', addr: ipaddr.parse(entry) };
  });
}

// Returns true if the given client IP string matches any compiled rule.
export function isAllowed(clientIpStr, compiled) {
  const normalized = (clientIpStr || '').replace(/^::ffff:/, '');
  let client;
  try {
    client = ipaddr.parse(normalized);
  } catch {
    return false;
  }
  return compiled.some(rule => {
    try {
      if (rule.type === 'ip') {
        return rule.addr.kind() === client.kind() && rule.addr.toString() === client.toString();
      }
      return client.kind() === rule.range[0].kind() && client.match(rule.range);
    } catch {
      return false;
    }
  });
}

// Extract the real client IP from a request, honouring X-Forwarded-For behind a proxy.
export function clientIpFromRequest(req, trustProxy) {
  let clientIpStr = req.ip;
  if (trustProxy) {
    const fwd = req.headers && req.headers['x-forwarded-for'];
    if (fwd) clientIpStr = fwd.split(',')[0].trim();
  }
  return clientIpStr;
}

// Build an Express middleware from an explicit config (easy to unit test).
export function createIpAllowlist({ allowedIps = [], trustProxy = false } = {}) {
  // Empty list = no restriction at this layer (nginx still filters).
  const compiled = allowedIps.length ? parseAllowed(allowedIps) : null;
  return function ipAllowlist(req, res, next) {
    if (!compiled) return next();
    const clientIpStr = clientIpFromRequest(req, trustProxy);
    if (isAllowed(clientIpStr, compiled)) return next();
    return res.status(403).json({ error: 'Access from this IP address is forbidden' });
  };
}

// Default middleware bound to the environment-driven config.
export const ipAllowlist = createIpAllowlist({
  allowedIps: config.allowedIps,
  trustProxy: config.trustProxy,
});
