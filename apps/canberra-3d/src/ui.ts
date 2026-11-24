import { PLACES, type Place } from './landmarks.ts';

export interface UiHooks {
  flyTo(p: Place): void;
  setHour(h: number): void;
  setBlur(on: boolean): void;
  setLabels(on: boolean): void;
  setAutumn(on: boolean): void;
  setLive(on: boolean): void;
  followTram(): boolean;
  setMode(mode: Mode): void;
  toggleView(): void;
}

export type Mode = 'explore' | 'drive' | 'fly';

export interface Ui {
  setMode(mode: Mode): void;
  setSpeed(kmh: number): void;
  /** Touch controls, present on every device and shown on touch screens. */
  stick: HTMLElement;
  lift: { up: boolean; down: boolean };
  setStatus(text: string): void;
  setLive(text: string, trams: number): void;
  setHour(h: number): void;
}

function el(tag: string, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElement {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
}
const input = (props: Record<string, unknown>) => el('input', props) as HTMLInputElement;

export const clockText = (h: number) => {
  const hh = Math.floor(h) % 24;
  const mm = Math.round((h - Math.floor(h)) * 60) % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};

/** Canberra's wall-clock hour and day of year, whatever zone the viewer is in. */
export function canberraNow(): { hour: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    hour12: false,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const day = Math.floor((Date.UTC(get('year'), get('month') - 1, get('day')) - Date.UTC(get('year'), 0, 0)) / 86400e3);
  return { hour: (get('hour') % 24) + get('minute') / 60, day };
}

export function buildUi(root: HTMLElement, hooks: UiHooks, initial: { hour: number }): Ui {
  const status = el('span', { className: 'status' }, 'Loading Canberra');
  const live = el('span', { className: 'live' });
  const dot = el('i', { className: 'dot' });

  const places = el('div', { className: 'places' });
  for (const p of PLACES) {
    const b = el('button', { type: 'button', className: 'place' }, el('strong', {}, p.name), el('span', {}, p.note));
    b.addEventListener('click', () => {
      hooks.flyTo(p);
      panel.classList.remove('open');
    });
    places.append(b);
  }

  const clock = el('output', { className: 'clock' }, clockText(initial.hour));
  const slider = input({
    type: 'range',
    min: '0',
    max: '24',
    step: '0.25',
    value: String(initial.hour),
    ariaLabel: 'Time of day',
  });
  slider.addEventListener('input', () => {
    clock.textContent = clockText(Number(slider.value));
    hooks.setHour(Number(slider.value));
  });
  const nowBtn = el('button', { type: 'button', className: 'chip' }, 'Now');
  nowBtn.addEventListener('click', () => {
    const { hour } = canberraNow();
    slider.value = String(hour);
    clock.textContent = clockText(hour);
    hooks.setHour(hour);
  });

  const toggle = (label: string, on: boolean, fn: (v: boolean) => void) => {
    const box = input({ type: 'checkbox', checked: on });
    box.addEventListener('change', () => fn(box.checked));
    return el('label', { className: 'toggle' }, box, el('span', {}, label));
  };

  const follow = el('button', { type: 'button', className: 'chip', hidden: true }, 'Follow a tram');
  follow.addEventListener('click', () => {
    if (!hooks.followTram()) follow.hidden = true;
  });

  const menu = el('button', { type: 'button', className: 'menu', ariaLabel: 'Places and settings' }, 'Places');
  const drive = el('button', { type: 'button', className: 'menu' }, 'Drive');
  const fly = el('button', { type: 'button', className: 'menu' }, 'Fly');
  drive.addEventListener('click', () => hooks.setMode('drive'));
  fly.addEventListener('click', () => hooks.setMode('fly'));
  const panel = el(
    'section',
    { className: 'panel' },
    el('header', {}, el('h1', {}, 'Canberra 3D'), el('span', { className: 'modes' }, drive, fly, menu)),
    el(
      'div',
      { className: 'body' },
      places,
      el('div', { className: 'row' }, el('span', { className: 'cap' }, 'Time'), clock, slider, nowBtn),
      el(
        'div',
        { className: 'row wrap' },
        toggle('Miniature focus', true, hooks.setBlur),
        toggle('Labels', true, hooks.setLabels),
        toggle('Live transport', true, hooks.setLive),
        toggle('Autumn leaves', false, hooks.setAutumn),
      ),
      el('div', { className: 'row' }, dot, live, follow),
    ),
    el('footer', {}, status),
  );
  menu.addEventListener('click', () => panel.classList.toggle('open'));

  const sources = el(
    'details',
    { className: 'credits' },
    el('summary', {}, 'Data'),
    el(
      'p',
      {},
      'Buildings, trees, street lights, car parks and sports fields: ACT Government open data (CC BY 4.0), with tree crowns from the 2020 LiDAR survey. ',
      'Building heights, roads, land use and water: Overture Maps, which includes © OpenStreetMap contributors and Microsoft building footprints (ODbL). ',
      'Terrain: Mapzen Terrain Tiles on AWS. Light rail: Canberra Metro and Transport Canberra GTFS (CC BY 4.0); tram positions are worked out from live arrival predictions.',
    ),
  );
  const hint = el('p', { className: 'hint' }, 'Drag to move · right-drag or two fingers to turn · scroll to zoom');

  // Street level: a speed readout, what the keys do, and the way out.
  const speed = el('output', { className: 'speed' }, '0');
  const keysHint = el('span', { className: 'keys' });
  const view = el('button', { type: 'button', className: 'chip' }, 'Change view');
  view.addEventListener('click', () => hooks.toggleView());
  const exit = el('button', { type: 'button', className: 'chip' }, 'Exit');
  exit.addEventListener('click', () => hooks.setMode('explore'));
  const hud = el(
    'div',
    { className: 'hud', hidden: true },
    speed,
    el('span', { className: 'cap' }, 'km/h'),
    keysHint,
    view,
    exit,
  );
  const stick = el('div', { className: 'stick', hidden: true });
  const lift = { up: false, down: false };
  const hold = (label: string, key: 'up' | 'down') => {
    const b = el('button', { type: 'button', className: 'chip', ariaLabel: key === 'up' ? 'Climb' : 'Descend' }, label);
    b.addEventListener('pointerdown', () => {
      lift[key] = true;
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
      b.addEventListener(type, () => {
        lift[key] = false;
      });
    }
    return b;
  };
  const liftPad = el('div', { className: 'lift', hidden: true }, hold('▲', 'up'), hold('▼', 'down'));
  root.append(panel, hint, sources, hud, stick, liftPad);
  setTimeout(() => hint.classList.add('gone'), 9000);

  return {
    stick,
    lift,
    setMode: (mode) => {
      const street = mode !== 'explore';
      hud.hidden = !street;
      stick.hidden = liftPad.hidden = !street;
      liftPad.hidden = mode !== 'fly';
      hint.hidden = street;
      view.hidden = mode !== 'drive';
      drive.classList.toggle('active', mode === 'drive');
      fly.classList.toggle('active', mode === 'fly');
      panel.classList.remove('open');
      keysHint.textContent =
        mode === 'drive'
          ? 'W A S D drive · Space brake · V view · drag to look · Esc exit'
          : 'W S fly · A D turn · Q E sideways · Space / C up and down · Shift boost · wheel sets speed · Esc exit';
    },
    setSpeed: (kmh) => {
      const t = String(Math.round(kmh));
      if (speed.textContent !== t) speed.textContent = t;
    },
    setStatus: (t) => {
      if (status.textContent !== t) status.textContent = t;
    },
    setLive: (t, trams) => {
      live.textContent = t;
      dot.classList.toggle('on', trams > 0);
      follow.hidden = trams === 0;
    },
    setHour: (h) => {
      slider.value = String(h);
      clock.textContent = clockText(h);
    },
  };
}
