/**
 * Probes "identity" (who the person is, as far as the computer knows) and "host" (what computer
 * this is and whether it can run routines around the clock).
 */
import { statfsSync } from 'node:fs'
import { hostname, release, totalmem, uptime, userInfo } from 'node:os'
import { join } from 'node:path'
import { IS_MAC, IS_WIN, sh } from '../lib.mjs'
import { EMAIL_RE, HOME, exists, names, powershellJson, readJson, readPlist, readText, sk } from './util.mjs'

/** Values of one section of a git config file ("user" → { name, email }). */
export function gitConfigSection(text, section) {
  const out = {}
  let current = null
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    const head = line.match(/^\[([^\]\s"]+)(?:\s+"([^"]*)")?\]$/)
    if (head) current = head[1].toLowerCase()
    else if (current === section) {
      const kv = line.match(/^([\w.-]+)\s*=\s*(.*)$/)
      if (kv) out[kv[1].toLowerCase()] = kv[2].replace(/^"|"$/g, '')
    }
  }
  return out
}

export async function identity(ctx) {
  const user = userInfo().username
  ctx.identity({ username: user, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null })

  await ctx.step('git', () => {
    const text = [join(HOME, '.gitconfig'), join(HOME, '.config', 'git', 'config')].map((p) => readText(p, 200_000)).filter(Boolean).join('\n')
    const u = gitConfigSection(text, 'user')
    ctx.identity({ gitName: u.name ?? null, gitEmail: u.email ?? null, emails: [u.email], nameHints: [u.name] })
  })

  await ctx.step('claude-account', () => {
    const acc = readJson(join(HOME, '.claude.json'))?.oauthAccount
    if (acc) ctx.identity({ emails: [acc.emailAddress], nameHints: [acc.fullName, acc.displayName] })
  })

  if (IS_MAC) {
    await ctx.step('name', async () => {
      const res = await sh('/usr/bin/id', ['-F'], { timeout: 5000 })
      if (res.code === 0 && res.out) ctx.identity({ fullName: res.out.split('\n')[0].trim() })
    })
    await ctx.step('language', async () => {
      const prefs = await readPlist(join(HOME, 'Library', 'Preferences', '.GlobalPreferences.plist'))
      if (!prefs) return
      ctx.identity({ locale: prefs.AppleLocale ?? null, languages: prefs.AppleLanguages ?? [] })
    })
    await ctx.step('keyboard', async () => {
      const prefs = await readPlist(join(HOME, 'Library', 'Preferences', 'com.apple.HIToolbox.plist'))
      const layouts = (prefs?.AppleEnabledInputSources ?? []).map((s) => s?.['KeyboardLayout Name']).filter(Boolean)
      ctx.identity({ keyboard: layouts })
    })
    await ctx.step('apple-id', async () => {
      const prefs = await readPlist(join(HOME, 'Library', 'Preferences', 'MobileMeAccounts.plist'))
      const acc = prefs?.Accounts?.[0]
      if (!acc) return
      const services = (acc.Services ?? []).filter((s) => s?.Enabled !== false).map((s) => s?.Name).filter(Boolean)
      ctx.identity({ appleId: acc.AccountID ?? null, emails: [acc.AccountID], nameHints: [acc.DisplayName], icloudServices: services })
    })
    await ctx.step('picture', async () => {
      const res = await sh('/usr/bin/dscl', ['.', '-read', `/Users/${user}`, 'Picture'], { timeout: 5000 })
      const path = res.out.replace(/^Picture:\s*/, '').trim()
      if (res.code === 0 && path.startsWith('/') && exists(path)) ctx.identity({ avatarPath: path })
    })
  } else if (IS_WIN) {
    await ctx.step('windows-account', async () => {
      const res = await powershellJson(
        `$u = Get-CimInstance Win32_UserAccount -Filter "Name='$env:USERNAME' AND Domain='$env:COMPUTERNAME'"
$ms = @(Get-ChildItem 'HKCU:\\Software\\Microsoft\\IdentityCRL\\UserExtendedProperties' | ForEach-Object { $_.PSChildName })
$langs = Get-WinUserLanguageList
$pic = Get-ChildItem "$env:APPDATA\\Microsoft\\Windows\\AccountPictures" -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
[pscustomobject]@{
  fullName = $u.FullName
  display = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Authentication\\LogonUI').LastLoggedOnDisplayName
  accounts = $ms
  languages = @($langs | ForEach-Object { $_.LanguageTag })
  keyboards = @($langs | ForEach-Object { $_.LocalizedName })
  culture = (Get-Culture).Name
  picture = $pic.FullName
} | ConvertTo-Json -Compress -Depth 3`,
      )
      if (!res) return
      const list = (v) => (Array.isArray(v) ? v : v ? [v] : [])
      ctx.identity({
        fullName: res.fullName || res.display || null,
        nameHints: [res.display],
        emails: list(res.accounts),
        languages: list(res.languages),
        keyboard: list(res.keyboards),
        locale: res.culture ?? null,
        avatarPath: res.picture ?? null,
      })
    })
  } else {
    await ctx.step('name', async () => {
      const res = await sh('getent', ['passwd', user], { timeout: 5000 })
      const full = res.out.split(':')[4]?.split(',')[0]?.trim()
      ctx.identity({ fullName: full || null, locale: process.env.LANG?.split('.')[0] ?? null, languages: [process.env.LANGUAGE ?? process.env.LANG?.split('.')[0]].filter(Boolean) })
    })
  }

  // public ssh keys often carry the owner's mail address as a comment
  await ctx.step('ssh-keys', async () => {
    const dir = join(HOME, '.ssh')
    const emails = []
    for (const name of (await names(dir)).filter((n) => n.endsWith('.pub')).slice(0, 10)) {
      emails.push(...((readText(join(dir, name), 20_000) ?? '').match(EMAIL_RE) ?? []))
    }
    ctx.identity({ emails })
  })
}

export async function host(ctx) {
  const info = { model: null, name: hostname(), os: `${process.platform} ${release()}`, laptop: false, battery: false, screens: null, diskFreeGB: null, alwaysOn: null }
  let sleepMinutes = null

  await ctx.step('disk', () => {
    const fs = statfsSync(HOME)
    info.diskFreeGB = Math.round((fs.bavail * fs.bsize) / 1_073_741_824)
  })
  info.memoryGB = Math.round(totalmem() / 1_073_741_824)
  info.uptimeDays = Math.round((uptime() / 86_400) * 10) / 10

  if (IS_MAC) {
    await Promise.all([
      ctx.step('hardware', async () => {
        const res = await sh('/usr/sbin/system_profiler', ['SPHardwareDataType', '-json'], { timeout: 12_000 })
        const hw = JSON.parse(res.out)?.SPHardwareDataType?.[0]
        if (!hw) return
        info.model = [hw.machine_name, hw.chip_type ?? hw.cpu_type].filter(Boolean).join(', ')
        info.laptop = /book/i.test(hw.machine_name ?? '')
      }),
      ctx.step('displays', async () => {
        const res = await sh('/usr/sbin/system_profiler', ['SPDisplaysDataType', '-json'], { timeout: 12_000 })
        const gpus = JSON.parse(res.out)?.SPDisplaysDataType ?? []
        info.screens = gpus.reduce((n, g) => n + (g.spdisplays_ndrvs?.length ?? 0), 0) || null
      }),
      ctx.step('system', async () => {
        const [name, ver] = await Promise.all([sh('/usr/sbin/scutil', ['--get', 'ComputerName'], { timeout: 5000 }), sh('/usr/bin/sw_vers', ['-productVersion'], { timeout: 5000 })])
        if (name.code === 0 && name.out) info.name = name.out
        if (ver.code === 0 && ver.out) info.os = `macOS ${ver.out}`
      }),
      ctx.step('power', async () => {
        const [batt, custom] = await Promise.all([sh('/usr/bin/pmset', ['-g', 'batt'], { timeout: 5000 }), sh('/usr/bin/pmset', ['-g', 'custom'], { timeout: 5000 })])
        info.battery = /InternalBattery/.test(batt.out)
        const ac = custom.out.split(/^AC Power:/m)[1] ?? custom.out
        const m = ac.match(/^\s*sleep\s+(\d+)/m)
        if (m) sleepMinutes = Number(m[1])
      }),
    ])
    if (info.battery) info.laptop = true
  } else if (IS_WIN) {
    await ctx.step('hardware', async () => {
      const res = await powershellJson(
        `$cs = Get-CimInstance Win32_ComputerSystem
$os = Get-CimInstance Win32_OperatingSystem
$pc = @(powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE | Select-String '0x[0-9a-fA-F]{8}\\s*$' | ForEach-Object { $_.Line.Trim() })
[pscustomobject]@{
  model = "$($cs.Manufacturer) $($cs.Model)"
  type = $cs.PCSystemType
  name = $cs.Name
  os = $os.Caption
  battery = @(Get-CimInstance Win32_Battery).Count
  screens = @(Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorBasicDisplayParams).Count
  cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name
  power = $pc
} | ConvertTo-Json -Compress -Depth 3`,
      )
      if (!res) return
      info.model = [res.model?.trim(), res.cpu?.trim()].filter(Boolean).join(', ') || null
      info.name = res.name ?? info.name
      info.os = res.os ?? info.os
      info.battery = Number(res.battery) > 0
      info.laptop = info.battery || Number(res.type) === 2
      info.screens = Number(res.screens) || null
      // powercfg prints the idle limits last: on mains, then on battery (seconds, hex)
      const power = Array.isArray(res.power) ? res.power : []
      const acLine = power[power.length - 2]?.match(/0x([0-9a-f]{8})\s*$/i)
      if (acLine) sleepMinutes = Math.round(parseInt(acLine[1], 16) / 60)
    })
  } else {
    await ctx.step('hardware', async () => {
      info.model = readText('/sys/devices/virtual/dmi/id/product_name')?.trim() || null
      info.os = readText('/etc/os-release')?.match(/^PRETTY_NAME="?([^"\n]+)/m)?.[1] ?? info.os
      info.battery = (await names('/sys/class/power_supply')).some((n) => /^BAT/.test(n))
      info.laptop = info.battery
    })
  }

  const kind = info.laptop ? 'Notebook' : 'Stolný počítač'
  if (info.laptop) info.alwaysOn = 'Notebook: keď je zatvorený alebo spí, rutiny počkajú a spustia sa hneď po zobudení.'
  else if (sleepMinutes === 0) info.alwaysOn = 'Stolný počítač, ktorý nezaspáva. Rutiny môžu bežať aj v noci, kým ho nevypneš.'
  else if (sleepMinutes) info.alwaysOn = `Stolný počítač, zaspí po ${sleepMinutes} minútach nečinnosti. Rutiny, ktoré zmeškajú svoj čas, sa spustia po zobudení.`
  if (info.alwaysOn && info.uptimeDays >= 7) info.alwaysOn += ` Teraz beží ${Math.round(info.uptimeDays)} dní bez vypnutia.`
  info.sleepMinutes = sleepMinutes
  ctx.host(info)

  ctx.finding({
    id: 'system.host',
    category: 'system',
    title: 'Tvoj počítač',
    detail: `${kind} ${info.model ?? ''} (${info.os}), ${info.screens ? `${sk(info.screens, 'obrazovka', 'obrazovky', 'obrazoviek')}, ` : ''}voľných ${info.diskFreeGB ?? '?'} GB na disku.`.replace(/\s+\(/, ' ('),
    data: { ...info },
    use: info.alwaysOn ?? 'Podľa toho, či počítač beží stále, nastavím časy rutín.',
    action: 'none',
    weight: 2,
  })
}
