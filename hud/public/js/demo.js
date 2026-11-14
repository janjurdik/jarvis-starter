// Sample conversation (?demo=1) for screenshots: the same shape as GET /api/chat/history,
// with made-up content and no names of people.

export const DEMO_HISTORY = [
  {
    turn: 'demo-1',
    via: 'voice',
    user: 'Ako som dnes spal?',
    tools: [{ id: 'd1', name: 'mcp__memory__get_health', label: 'Pozerám spánok', icon: 'spanok', node: 'spanok', status: 'ok' }],
    jarvis: 'Sedem hodín a osemnásť minút. Na pondelok slušný výkon.',
    cards: [{ id: 'c1', kind: 'stat', title: 'Spánok dnes v noci', icon: 'spanok', node: 'spanok', value: '7 h 18 min', caption: 'priemer týždňa 6 h 50 min' }],
    at: '2026-01-12T21:31:00+01:00',
  },
  {
    turn: 'demo-2',
    via: 'text',
    user: 'Čo ma dnes ešte čaká?',
    tools: [
      { id: 'd2', name: 'mcp__memory__calendar_list', label: 'Pozerám kalendár', icon: 'kalendar', node: 'kalendar', status: 'ok' },
      { id: 'd3', name: 'mcp__memory__view_todo', label: 'Pozerám úlohy', icon: 'todo', status: 'ok' },
    ],
    jarvis: 'O šiestej máte tréning a do večera treba poslať faktúru. Večerné zhrnutie pripravím o pol desiatej.',
    cards: [
      {
        id: 'c2',
        kind: 'list',
        title: 'Zvyšok dňa',
        icon: 'kalendar',
        node: 'kalendar',
        accent: 'amber',
        items: [
          { label: 'Tréning', sub: 'park', value: '18:00' },
          { label: 'Poslať faktúru', sub: 'úloha s termínom', value: 'dnes' },
          { label: 'Večerné zhrnutie', sub: 'Jarvis', value: '21:30' },
        ],
      },
    ],
    at: '2026-01-12T21:38:00+01:00',
  },
]
