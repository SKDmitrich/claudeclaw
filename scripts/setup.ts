#!/usr/bin/env tsx
import { createInterface } from 'readline'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { execSync, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'
import os from 'os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')

// ── ANSI colors ───────────────────────────────
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

function ok(msg: string) { console.log(`  ${green('✓')} ${msg}`) }
function warn(msg: string) { console.log(`  ${yellow('⚠')} ${msg}`) }
function fail(msg: string) { console.log(`  ${red('✗')} ${msg}`) }
function info(msg: string) { console.log(`  ${dim('›')} ${msg}`) }

// ── Banner ────────────────────────────────────
function showBanner() {
  try {
    const bannerPath = path.join(PROJECT_ROOT, 'banner.txt')
    if (existsSync(bannerPath)) {
      console.log(readFileSync(bannerPath, 'utf-8'))
      return
    }
  } catch {}
  console.log(bold('\n=== ClaudeClaw Setup Wizard ===\n'))
}

// ── Readline helper ───────────────────────────
function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve))
}

// ── Requirements check ────────────────────────
function checkRequirements(): boolean {
  let allGood = true

  // Node version
  const nodeVersion = parseInt(process.versions.node.split('.')[0])
  if (nodeVersion >= 20) {
    ok(`Node.js ${process.versions.node}`)
  } else {
    fail(`Node.js ${process.versions.node} — need 20+`)
    allGood = false
  }

  // Claude CLI
  try {
    const result = spawnSync('claude', ['--version'], { encoding: 'utf-8' })
    if (result.status === 0) {
      ok(`claude CLI: ${result.stdout.trim()}`)
    } else {
      fail('claude CLI not found or not authenticated. Run: npm install -g @anthropic-ai/claude-code && claude login')
      allGood = false
    }
  } catch {
    fail('claude CLI not found. Install it and run `claude login` first.')
    allGood = false
  }

  return allGood
}

// ── Build project ─────────────────────────────
function buildProject(): boolean {
  console.log('\n' + bold('Building project...'))
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    stdio: 'pipe',
  })
  if (result.status === 0) {
    ok('Build successful')
    return true
  } else {
    fail('Build failed')
    console.error(result.stderr)
    return false
  }
}

// ── Write .env ────────────────────────────────
function writeEnv(values: Record<string, string>): void {
  const envPath = path.join(PROJECT_ROOT, '.env')
  const lines = Object.entries(values)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
  writeFileSync(envPath, lines.join('\n') + '\n')
}

function readExistingEnv(): Record<string, string> {
  const envPath = path.join(PROJECT_ROOT, '.env')
  if (!existsSync(envPath)) return {}
  const result: Record<string, string> = {}
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    result[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim()
  }
  return result
}

// ── Background service ────────────────────────
function installServiceMacOS(): void {
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.claudeclaw.app.plist')
  const logPath = '/tmp/claudeclaw.log'
  const nodePath = process.execPath

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claudeclaw.app</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${path.join(PROJECT_ROOT, 'dist', 'index.js')}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PATH</key>
    <string>${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}</string>
  </dict>
</dict>
</plist>`

  mkdirSync(path.dirname(plistPath), { recursive: true })
  writeFileSync(plistPath, plist)

  try {
    spawnSync('launchctl', ['unload', plistPath], { encoding: 'utf-8' })
    const load = spawnSync('launchctl', ['load', plistPath], { encoding: 'utf-8' })
    if (load.status === 0) {
      ok(`launchd service installed → ${plistPath}`)
      ok('ClaudeClaw will start automatically on login')
    } else {
      warn(`launchd load returned non-zero: ${load.stderr}`)
    }
  } catch (err) {
    warn(`Could not load launchd service: ${err}`)
  }
}

function installServiceLinux(): void {
  const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user')
  const servicePath = path.join(serviceDir, 'claudeclaw.service')
  const nodePath = process.execPath

  const unit = `[Unit]
Description=ClaudeClaw AI Assistant
After=network.target

[Service]
Type=simple
WorkingDirectory=${PROJECT_ROOT}
ExecStart=${nodePath} ${path.join(PROJECT_ROOT, 'dist', 'index.js')}
Restart=on-failure
RestartSec=5s
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`

  mkdirSync(serviceDir, { recursive: true })
  writeFileSync(servicePath, unit)

  try {
    spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf-8' })
    spawnSync('systemctl', ['--user', 'enable', 'claudeclaw'], { encoding: 'utf-8' })
    const start = spawnSync('systemctl', ['--user', 'start', 'claudeclaw'], { encoding: 'utf-8' })
    if (start.status === 0) {
      ok(`systemd service installed → ${servicePath}`)
      ok('ClaudeClaw will start automatically on login')
    } else {
      warn(`systemd start failed: ${start.stderr}`)
    }
  } catch (err) {
    warn(`Could not install systemd service: ${err}`)
  }
}

// ── Main wizard ───────────────────────────────
async function main() {
  showBanner()
  console.log(bold('Welcome to ClaudeClaw setup.\n'))

  console.log('Checking requirements...')
  const reqOk = checkRequirements()
  if (!reqOk) {
    console.log(red('\nFix the above issues before continuing.'))
    process.exit(1)
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const existing = readExistingEnv()
  const config: Record<string, string> = { ...existing }

  console.log('\n' + bold('── Telegram configuration ──────────────────'))
  console.log(dim('Go to @BotFather on Telegram, send /newbot, follow the prompts to get your token.'))

  if (config['TELEGRAM_BOT_TOKEN']) {
    info(`Using existing token: ${config['TELEGRAM_BOT_TOKEN'].slice(0, 10)}...`)
  } else {
    const token = await ask(rl, '\nTelegram bot token: ')
    config['TELEGRAM_BOT_TOKEN'] = token.trim()
  }

  console.log('\n' + bold('── Voice configuration ─────────────────────'))
  console.log(dim('Groq STT: free at https://console.groq.com → API Keys'))
  const groqKey = await ask(rl, `GROQ_API_KEY${config['GROQ_API_KEY'] ? ' (enter to keep existing)' : ''}: `)
  if (groqKey.trim()) config['GROQ_API_KEY'] = groqKey.trim()

  console.log(dim('\nElevenLabs TTS: free tier at https://elevenlabs.io → Profile → API Key'))
  const elKey = await ask(rl, `ELEVENLABS_API_KEY${config['ELEVENLABS_API_KEY'] ? ' (enter to keep existing)' : ''}: `)
  if (elKey.trim()) config['ELEVENLABS_API_KEY'] = elKey.trim()

  if (config['ELEVENLABS_API_KEY']) {
    console.log(dim('Find voice IDs at https://elevenlabs.io/voice-library'))
    const voiceId = await ask(rl, `ELEVENLABS_VOICE_ID${config['ELEVENLABS_VOICE_ID'] ? ' (enter to keep existing)' : ''}: `)
    if (voiceId.trim()) config['ELEVENLABS_VOICE_ID'] = voiceId.trim()
  }

  // Write .env
  writeEnv(config)
  ok('.env written')

  // Build
  const built = buildProject()
  if (!built) {
    rl.close()
    process.exit(1)
  }

  // Install service
  console.log('\n' + bold('── Background service ──────────────────────'))
  const installService = await ask(rl, 'Install as background service (starts on boot)? [Y/n]: ')
  if (installService.trim().toLowerCase() !== 'n') {
    const platform = process.platform
    if (platform === 'darwin') {
      installServiceMacOS()
    } else if (platform === 'linux') {
      installServiceLinux()
    } else {
      warn('Windows detected. Install PM2 globally: npm install -g pm2')
      info(`Then run: pm2 start ${path.join(PROJECT_ROOT, 'dist', 'index.js')} --name claudeclaw`)
      info('And: pm2 save && pm2 startup')
    }
  }

  // Open CLAUDE.md for editing
  console.log('\n' + bold('── Personalize your assistant ──────────────'))
  console.log(dim('CLAUDE.md is the persistent system prompt. Fill in your name and context.'))
  const openEditor = await ask(rl, 'Open CLAUDE.md in your editor now? [Y/n]: ')
  if (openEditor.trim().toLowerCase() !== 'n') {
    const editor = process.env.EDITOR ?? (process.platform === 'darwin' ? 'open' : 'nano')
    spawnSync(editor, [path.join(PROJECT_ROOT, 'CLAUDE.md')], { stdio: 'inherit' })
  }

  // Chat ID
  console.log('\n' + bold('── Get your chat ID ────────────────────────'))
  console.log(dim('Start the bot and send /chatid to your bot on Telegram.'))

  if (!config['ALLOWED_CHAT_ID']) {
    const chatId = await ask(rl, 'Your Telegram chat ID (or press Enter to set later): ')
    if (chatId.trim()) {
      config['ALLOWED_CHAT_ID'] = chatId.trim()
      writeEnv(config)
      ok('ALLOWED_CHAT_ID saved to .env')
    } else {
      warn('ALLOWED_CHAT_ID not set. The bot will accept messages from anyone until you set it.')
    }
  } else {
    ok(`ALLOWED_CHAT_ID: ${config['ALLOWED_CHAT_ID']}`)
  }

  rl.close()

  // Create runtime dirs
  mkdirSync(path.join(PROJECT_ROOT, 'store'), { recursive: true })
  mkdirSync(path.join(PROJECT_ROOT, 'workspace', 'uploads'), { recursive: true })

  console.log('\n' + bold('── Setup complete ──────────────────────────'))
  ok('ClaudeClaw is ready')
  console.log(`
Next steps:
  ${bold('npm run start')}        Start the bot
  ${bold('npm run status')}       Check configuration
  ${bold('npm run dev')}          Run in dev mode (hot reload)

Scheduled tasks:
  ${bold('node dist/schedule-cli.js create "Daily briefing" "0 9 * * *" YOUR_CHAT_ID')}

If the bot is running as a service, check logs:
  macOS:  tail -f /tmp/claudeclaw.log
  Linux:  journalctl --user -u claudeclaw -f
`)
}

main().catch(err => {
  console.error(red('\nSetup failed: ' + err.message))
  process.exit(1)
})
