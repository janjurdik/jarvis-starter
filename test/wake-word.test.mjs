import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanCommand, hasWakeWord, isWakeCall, stripWakeWord } from '../hud/server/mic.mjs'

test('Ahoj Jarvis sa z príkazu odstráni, aj s pre-rollom pred ním', () => {
  assert.equal(cleanCommand('Ahoj Jarvis, čo mám dnes v kalendári?'), 'čo mám dnes v kalendári?')
  assert.equal(cleanCommand('Ahoj, Džarvis. Pusti mi hudbu.'), 'Pusti mi hudbu.')
  assert.equal(cleanCommand('no a potom ahoj Jarvis aký je dnes deň'), 'aký je dnes deň')
  assert.equal(cleanCommand('Hey Jarvis, open Spotify'), 'open Spotify')
  assert.equal(cleanCommand('Jarvisi, koľko je hodín?'), 'koľko je hodín?')
})

test('ďalší Jarvis v príkaze ostáva', () => {
  assert.equal(cleanCommand('Ahoj Jarvis, povedz mi niečo o Jarvisovi z Iron Mana'), 'povedz mi niečo o Jarvisovi z Iron Mana')
})

test('chvost „…vis“ z pre-rollu bez celého slova', () => {
  assert.equal(cleanCommand('vis, otvor Spotify'), 'otvor Spotify')
})

test('planý poplach: v prepise nie je Jarvis', () => {
  assert.equal(hasWakeWord('Ahoj Jaro, ako sa máš?'), false)
  assert.equal(hasWakeWord('Ahoj všetci, vitajte pri videu'), false)
  assert.equal(hasWakeWord('Ahoj Džarvis'), true)
  assert.equal(hasWakeWord('ahoy jarvis'), true)
})

test('stripWakeWord nechá text pred aj za', () => {
  assert.equal(stripWakeWord('Ahoj Jarvis zapni svetlo'), 'zapni svetlo')
  assert.equal(stripWakeWord('bez mena'), 'bez mena')
})

test('probe: oslovenie áno, reč o Jarvisovi nie', () => {
  for (const t of ['Ahoj Jarvis.', 'Ahoj, Džarvis, pusti mi hudbu.', 'Jarvis, koľko je hodín?', 'Hej Jarvis', 'Čau Jarvis!', 'no a potom ahoj Jarvis čo mám dnes']) assert.equal(isWakeCall(t), true, t)
  for (const t of ['Včera som robil na Jarvisovi.', 'Ahoj Jaro, ako sa máš?', 'Pozeral som Iron Mana, Jarvis je tam super', '']) assert.equal(isWakeCall(t), false, t)
})
