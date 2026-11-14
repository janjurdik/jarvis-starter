/**
 * Weather from Open-Meteo (no key needed). The place is geocoded by name.
 */
import { clean, hhmm, isoDay } from './util.mjs'

const PLACES = {}

const WMO = [
  [[0], 'jasno', 'sun'],
  [[1], 'prevažne jasno', 'sun'],
  [[2], 'polojasno', 'partly'],
  [[3], 'zamračené', 'cloud'],
  [[45, 48], 'hmla', 'fog'],
  [[51, 53, 55, 56, 57], 'mrholenie', 'drizzle'],
  [[61, 63, 65, 66, 67, 80, 81, 82], 'dážď', 'rain'],
  [[71, 73, 75, 77, 85, 86], 'sneženie', 'snow'],
  [[95, 96, 99], 'búrka', 'storm'],
]

export function describeWmo(code, isDay = true) {
  const hit = WMO.find(([codes]) => codes.includes(code)) ?? [[], 'neznáme', 'cloud']
  let icon = hit[2]
  if (!isDay && icon === 'sun') icon = 'moon'
  if (!isDay && icon === 'partly') icon = 'partly-night'
  return { text: hit[1], icon }
}

const cache = new Map()

async function geocode(place) {
  const key = place.toLowerCase().trim()
  if (PLACES[key]) return PLACES[key]
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search')
  url.searchParams.set('name', place)
  url.searchParams.set('count', '1')
  url.searchParams.set('language', 'sk')
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
  if (!res.ok) throw new Error(`geocoding ${res.status}`)
  const hit = (await res.json()).results?.[0]
  if (!hit) throw new Error(`miesto „${place}" som nenašiel`)
  return { name: hit.name, lat: hit.latitude, lon: hit.longitude, country: hit.country }
}

/**
 * Aktuálne počasie + dnešné min/max + najbližších 6 hodín + `days` dní dopredu.
 * Cache 10 min na miesto.
 */
export async function getWeather(place = 'Bratislava', days = 3) {
  const p = clean(place, 60) || 'Bratislava'
  const key = `${p.toLowerCase()}|${days}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 600_000) return hit.value
  const loc = await geocode(p)
  const url = new URL('https://api.open-meteo.com/v1/forecast')
  url.searchParams.set('latitude', String(loc.lat))
  url.searchParams.set('longitude', String(loc.lon))
  url.searchParams.set('current', 'temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m,precipitation')
  url.searchParams.set('hourly', 'temperature_2m,weather_code,is_day,precipitation_probability')
  url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,sunrise,sunset')
  url.searchParams.set('timezone', 'auto')
  url.searchParams.set('forecast_days', String(Math.min(7, Math.max(1, days))))
  url.searchParams.set('timeformat', 'unixtime')
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`)
  const data = await res.json()
  const c = data.current
  const now = describeWmo(c.weather_code, c.is_day === 1)
  const nowS = Date.now() / 1000
  const hours = []
  for (let i = 0; i < data.hourly.time.length && hours.length < 6; i++) {
    if (data.hourly.time[i] < nowS - 1800) continue
    const d = describeWmo(data.hourly.weather_code[i], data.hourly.is_day[i] === 1)
    hours.push({
      time: hhmm(data.hourly.time[i] * 1000),
      tempC: Math.round(data.hourly.temperature_2m[i]),
      icon: d.icon,
      rainPct: data.hourly.precipitation_probability?.[i] ?? null,
    })
  }
  const daily = data.daily.time.map((t, i) => {
    const d = describeWmo(data.daily.weather_code[i], true)
    return {
      day: isoDay(new Date(t * 1000)),
      highC: Math.round(data.daily.temperature_2m_max[i]),
      lowC: Math.round(data.daily.temperature_2m_min[i]),
      text: d.text,
      icon: d.icon,
      precipMm: Math.round((data.daily.precipitation_sum[i] ?? 0) * 10) / 10,
    }
  })
  const value = {
    place: loc.name,
    tempC: Math.round(c.temperature_2m),
    feelsC: Math.round(c.apparent_temperature),
    text: now.text,
    icon: now.icon,
    isDay: c.is_day === 1,
    windKmh: Math.round(c.wind_speed_10m),
    precipMm: c.precipitation ?? 0,
    highC: daily[0]?.highC ?? null,
    lowC: daily[0]?.lowC ?? null,
    sunrise: data.daily.sunrise?.[0] ? hhmm(data.daily.sunrise[0] * 1000) : null,
    sunset: data.daily.sunset?.[0] ? hhmm(data.daily.sunset[0] * 1000) : null,
    hours,
    daily,
    at: new Date().toISOString(),
  }
  cache.set(key, { at: Date.now(), value })
  return value
}
