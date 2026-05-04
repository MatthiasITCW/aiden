import { describe, it, expect } from 'vitest';
import dns from 'node:dns';
import { SSRFProtection } from '../../../moat/ssrfProtection';

const fakeLookup = (
  map: Record<string, string[]>,
): ((h: string) => Promise<dns.LookupAddress[]>) => {
  return async (h: string) => {
    const ips = map[h];
    if (!ips) throw new Error(`ENOTFOUND ${h}`);
    return ips.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    })) as dns.LookupAddress[];
  };
};

describe('SSRFProtection', () => {
  it('1. blocks 127.0.0.1', async () => {
    const ssrf = new SSRFProtection();
    const r = await ssrf.check('http://127.0.0.1/admin');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('loopback');
  });

  it('2. blocks ::1 (IPv6 loopback)', async () => {
    const ssrf = new SSRFProtection();
    const r = await ssrf.check('http://[::1]:8080/');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('loopback');
  });

  it('3. blocks 10.x (RFC 1918)', async () => {
    const ssrf = new SSRFProtection();
    expect((await ssrf.check('http://10.0.0.5/')).blocked).toBe(true);
    expect((await ssrf.check('http://10.255.255.255/')).blocked).toBe(true);
  });

  it('4. blocks 172.16-31.x (RFC 1918)', async () => {
    const ssrf = new SSRFProtection();
    expect((await ssrf.check('http://172.16.0.1/')).blocked).toBe(true);
    expect((await ssrf.check('http://172.31.255.255/')).blocked).toBe(true);
    // 172.32.x.x is OUTSIDE RFC 1918 — public-ish range, not blocked.
    const out = await ssrf.check('http://172.32.0.1/');
    expect(out.blocked).toBe(false);
  });

  it('5. blocks 192.168.x', async () => {
    const ssrf = new SSRFProtection();
    expect((await ssrf.check('http://192.168.1.1/')).blocked).toBe(true);
  });

  it('6. blocks 169.254.169.254 (AWS/GCP/Azure metadata)', async () => {
    const ssrf = new SSRFProtection();
    const r = await ssrf.check('http://169.254.169.254/latest/meta-data/');
    expect(r.blocked).toBe(true);
    expect(['cloud_metadata', 'link_local']).toContain(r.category);
  });

  it('7. blocks 100.64.x (CGNAT / Tailscale)', async () => {
    const ssrf = new SSRFProtection();
    const r = await ssrf.check('http://100.64.0.1/');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('cgnat');
  });

  it('8. blocks metadata.google.internal by hostname', async () => {
    const ssrf = new SSRFProtection(fakeLookup({}));
    const r = await ssrf.check('http://metadata.google.internal/');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('cloud_metadata');
  });

  it('9. allows public IP after DNS lookup', async () => {
    const ssrf = new SSRFProtection(
      fakeLookup({ 'example.com': ['93.184.216.34'] }),
    );
    const r = await ssrf.check('http://example.com/path');
    expect(r.blocked).toBe(false);
  });

  it('10. blocks DNS rebinding (evil.example resolving to 127.0.0.1)', async () => {
    const ssrf = new SSRFProtection(
      fakeLookup({ 'evil.example.com': ['127.0.0.1'] }),
    );
    const r = await ssrf.check('http://evil.example.com/');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('loopback');
  });

  it('11. blocks even when one of multiple resolved IPs is private', async () => {
    const ssrf = new SSRFProtection(
      fakeLookup({ 'mixed.example.com': ['8.8.8.8', '10.0.0.5'] }),
    );
    const r = await ssrf.check('http://mixed.example.com/');
    expect(r.blocked).toBe(true);
  });

  it('12. blocks non-http schemes', async () => {
    const ssrf = new SSRFProtection();
    const r = await ssrf.check('file:///etc/passwd');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('unsupported_scheme');
  });

  it('13. handles invalid URL gracefully', async () => {
    const ssrf = new SSRFProtection();
    const r = await ssrf.check('not a url');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('invalid');
  });

  it('14. blocks IPv6 link-local fe80::/10', async () => {
    const ssrf = new SSRFProtection();
    const r = await ssrf.check('http://[fe80::1]/');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('link_local');
  });

  it('15. allows public IP literal (8.8.8.8)', async () => {
    const ssrf = new SSRFProtection();
    const r = await ssrf.check('http://8.8.8.8/');
    expect(r.blocked).toBe(false);
  });
});
