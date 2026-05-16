/**
 * v4.5 Phase 1 — launchd plist generator tests.
 */
import { describe, it, expect } from 'vitest';
import { generateLaunchdPlist } from '../../../../core/v4/daemon/supervisor';

describe('generateLaunchdPlist', () => {
  it('emits valid plist XML with KeepAlive.SuccessfulExit=false', () => {
    const plist = generateLaunchdPlist({
      nodeBin:        '/usr/local/bin/node',
      bundlePath:     '/Users/u/aiden/dist-bundle/index.js',
      workingDir:     '/Users/u',
      port:           4200,
      drainTimeoutMs: 30_000,
      userPath:       '/usr/local/bin:/usr/bin:/bin',
    });
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>SuccessfulExit</key>');
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
  });

  it('captures user PATH in EnvironmentVariables', () => {
    const plist = generateLaunchdPlist({
      nodeBin: 'node', bundlePath: 'b', workingDir: '/w', port: 1, drainTimeoutMs: 30_000,
      userPath: '/opt/homebrew/bin:/usr/bin',
    });
    expect(plist).toContain('<key>PATH</key>');
    expect(plist).toContain('/opt/homebrew/bin:/usr/bin');
  });

  it('omits PATH when userPath unset', () => {
    const plist = generateLaunchdPlist({
      nodeBin: 'node', bundlePath: 'b', workingDir: '/w', port: 1, drainTimeoutMs: 30_000,
    });
    expect(plist).not.toContain('<key>PATH</key>');
  });

  it('sets AIDEN_DAEMON=1 + AIDEN_PORT', () => {
    const plist = generateLaunchdPlist({
      nodeBin: 'node', bundlePath: 'b', workingDir: '/w', port: 4242, drainTimeoutMs: 30_000,
    });
    expect(plist).toContain('AIDEN_DAEMON');
    expect(plist).toContain('AIDEN_PORT');
    expect(plist).toContain('4242');
  });

  it('escapes XML special characters in paths', () => {
    const plist = generateLaunchdPlist({
      nodeBin: '/path/with "quotes" & ampersands/node',
      bundlePath: '/p<b>', workingDir: '/w', port: 1, drainTimeoutMs: 30_000,
    });
    expect(plist).toContain('&quot;');
    expect(plist).toContain('&amp;');
    expect(plist).toContain('&lt;');
  });

  it('label is com.aiden.daemon', () => {
    const plist = generateLaunchdPlist({
      nodeBin: 'node', bundlePath: 'b', workingDir: '/w', port: 1, drainTimeoutMs: 30_000,
    });
    expect(plist).toContain('<string>com.aiden.daemon</string>');
  });
});
