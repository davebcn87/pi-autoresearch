const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const motionDisabled = reducedMotion.matches || new URLSearchParams(location.search).has('static');

const publishedResults = {
  polaris: {
    subtitle: 'Polaris visual regression build',
    baselineValue: 19.1,
    unit: 's',
    cards: [
      ['Baseline → Best', '19.1s → ≈6.69s'],
      ['Improvement', '65% faster'],
      ['Runs', '12'],
      ['Kept', '9 / 12'],
    ],
    chartLabel: 'Normalized build runtime',
    chartChange: '−65%',
    values: [100, 91, 94, 82, 76, 79, 67, 59, 62, 48, 41, 35],
    statuses: ['keep', 'keep', 'discard', 'keep', 'keep', 'discard', 'keep', 'keep', 'discard', 'keep', 'keep', 'keep'],
    descriptions: ['Full VRT build baseline', 'Skip declaration emit for Storybook', 'Increase transform workers', 'Compile Storybook from source', 'Limit TypeScript transform scope', 'Disable source maps globally', 'Transform matched files only', 'Reuse resolved configuration', 'Cache all module resolution', 'Skip redundant IIFE bundle', 'Narrow component entry points', 'Transform only 105 matched files'],
  },
  liquid: {
    subtitle: 'Shopify Liquid parse and render',
    baselineValue: 100,
    unit: '',
    cards: [
      ['Baseline → Best', '100 → 47'],
      ['Improvement', '53% faster'],
      ['Runs', '12'],
      ['Kept', '8 / 12'],
    ],
    chartLabel: 'Normalized combined parse + render time',
    chartChange: '−53%',
    values: [100, 93, 88, 91, 79, 73, 76, 67, 60, 55, 49, 47],
    statuses: ['keep', 'keep', 'keep', 'discard', 'keep', 'keep', 'discard', 'keep', 'keep', 'keep', 'keep', 'keep'],
    descriptions: ['Liquid baseline', 'Inline common parse branch', 'Reuse render buffers', 'Cache every parsed token', 'Avoid temporary arrays', 'Fast path simple variables', 'Pool all string objects', 'Reuse parser cursor', 'Lazy inspection metadata', 'Reduce node allocations', 'Compact render context', 'Final combined parse + render'],
  },
};

initializePage();

function initializePage() {
  initializeMotion();
  initializeCopyButtons();
  initializeGitHubStars();
  initializeCastPlayers();
  initializeResultsDashboard();
  initializeTweetEmbeds();
}

function initializeMotion() {
  if (motionDisabled) return;

  document.body.classList.add('motion-ready');
  const revealTargets = document.querySelectorAll([
    '.chapter .section-heading',
    '.experiment-journal',
    '.journal-row',
    '.prompt-example',
    '.file-card',
    '.confidence-layout',
    '.browser-dashboard',
    '.share-showcase-copy',
    '.social-post',
    '.tweet-grid',
    '.metric-table',
    '.code-window',
    '.guardrail-list article',
    '.finalize-demo',
    '.monitor-list article',
    '.hooks-list span',
  ].join(','));

  revealTargets.forEach((target) => target.classList.add('reveal'));
  const observer = new IntersectionObserver(revealVisibleTarget, {
    rootMargin: '0px 0px -8% 0px',
    threshold: 0.08,
  });
  revealTargets.forEach((target) => observer.observe(target));
}

function revealVisibleTarget(entries, observer) {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add('is-visible');
    observer.unobserve(entry.target);
  });
}

function initializeCopyButtons() {
  document.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', () => copyCommand(button));
  });
}

async function copyCommand(button) {
  const command = button.dataset.copy;
  if (!command) return;

  await writeToClipboard(command);
  showCopiedState(button);
}

async function writeToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const input = document.createElement('textarea');
  input.value = text;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  document.execCommand('copy');
  input.remove();
}

function showCopiedState(button) {
  const label = button.querySelector('span');
  button.classList.add('copied');
  button.setAttribute('aria-label', 'Install command copied');
  if (label) label.textContent = 'Copied';

  window.setTimeout(() => restoreCopyState(button, label), 1800);
}

function restoreCopyState(button, label) {
  button.classList.remove('copied');
  button.setAttribute('aria-label', 'Copy install command');
  if (label) label.textContent = 'Copy';
}

function initializeGitHubStars() {
  fetch('https://api.github.com/repos/davebcn87/pi-autoresearch', {
    headers: {Accept: 'application/vnd.github+json'},
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  })
    .then((response) => response.ok ? response.json() : null)
    .then(updateGitHubStars)
    .catch(() => undefined);
}

function updateGitHubStars(repository) {
  const stars = repository?.stargazers_count;
  if (!Number.isSafeInteger(stars) || stars < 0) return;

  const formattedStars = new Intl.NumberFormat('en-US').format(stars);
  document.querySelectorAll('[data-github-stars]').forEach((element) => {
    element.textContent = formattedStars;
  });
  const starLink = document.querySelector('.github-star');
  starLink?.setAttribute('aria-label', `Star pi-autoresearch on GitHub. ${formattedStars} stars.`);
}

function initializeCastPlayers() {
  if (!window.AsciinemaPlayer) return;
  document.querySelectorAll('[data-cast-player]').forEach(mountCastPlayer);
}

function mountCastPlayer(mount) {
  const castPath = selectCastFor(mount);
  const player = window.AsciinemaPlayer.create(embeddedCastSource(castPath), mount, {
    autoPlay: !motionDisabled,
    controls: false,
    fit: 'width',
    idleTimeLimit: 1.5,
    loop: !motionDisabled,
    poster: 'npt:10',
    speed: 1,
    terminalFontFamily: 'IBM Plex Mono, SFMono-Regular, Menlo, monospace',
    terminalLineHeight: 1.45,
  });

  mount.dataset.userPaused = String(motionDisabled);
  wireCastInteraction(mount, player);
  if (!motionDisabled) pauseCastWhenOffscreen(mount, player);
}

function selectCastFor(mount) {
  if (window.innerWidth <= 640 && mount.dataset.mobileCast) {
    return mount.dataset.mobileCast;
  }
  return mount.dataset.desktopCast;
}

function wireCastInteraction(mount, player) {
  updateCastInteraction(mount, !motionDisabled);
  mount.addEventListener('click', () => toggleCastPlayback(mount, player));
  mount.addEventListener('keydown', (event) => handleCastKeydown(event, mount, player));
  player.addEventListener('play', () => updateCastInteraction(mount, true));
  player.addEventListener('pause', () => updateCastInteraction(mount, false));
  player.addEventListener('ended', () => updateCastInteraction(mount, false));
}

function handleCastKeydown(event, mount, player) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  toggleCastPlayback(mount, player);
}

function toggleCastPlayback(mount, player) {
  const isPlaying = mount.dataset.playing === 'true';
  mount.dataset.userPaused = String(isPlaying);
  if (isPlaying) {
    player.pause();
    return;
  }
  player.play();
}

function updateCastInteraction(mount, isPlaying) {
  mount.dataset.playing = String(isPlaying);
  mount.setAttribute('aria-pressed', String(isPlaying));
  mount.setAttribute(
    'aria-label',
    `${isPlaying ? 'Playing' : 'Paused'} interactive terminal recording. Press Space or Enter to ${isPlaying ? 'pause' : 'play'}.`,
  );
}

function embeddedCastSource(path) {
  const cast = window.autoresearchCasts?.[path];
  if (!cast) return path;
  return URL.createObjectURL(new Blob([cast], {type: 'text/plain'}));
}

function pauseCastWhenOffscreen(mount, player) {
  const observer = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) {
      player.pause();
      return;
    }
    if (mount.dataset.userPaused === 'false') player.play();
  }, {threshold: 0.2});
  observer.observe(mount);
}

function initializeTweetEmbeds() {
  const section = document.querySelector('[data-tweet-section]');
  const button = section?.querySelector('[data-load-tweets]');
  if (!section || !button) return;
  window.addEventListener('message', resizeSandboxedTweetEmbed);
  button.addEventListener('click', () => loadSandboxedTweetEmbeds(section, button));
}

function loadSandboxedTweetEmbeds(section, button) {
  const quotes = section.querySelectorAll('[data-tweet-id]');
  quotes.forEach(replaceQuoteWithSandboxedEmbed);
  button.remove();
}

function replaceQuoteWithSandboxedEmbed(quote) {
  const tweetId = quote.dataset.tweetId;
  if (!/^\d+$/.test(tweetId ?? '')) return;

  const embed = document.createElement('iframe');
  const source = new URL('https://platform.twitter.com/embed/Tweet.html');
  source.search = new URLSearchParams({id: tweetId, theme: 'dark', dnt: 'true'});
  embed.className = 'tweet-embed';
  embed.dataset.tweetId = tweetId;
  embed.src = source;
  embed.title = `X post by ${quote.dataset.tweetAuthor ?? 'the quoted author'}`;
  embed.loading = 'lazy';
  embed.referrerPolicy = 'no-referrer';
  embed.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  quote.replaceWith(embed);
}

function resizeSandboxedTweetEmbed(event) {
  if (event.origin !== 'https://platform.twitter.com') return;
  const message = event.data?.['twttr.embed'];
  if (message?.method !== 'twttr.private.resize') return;

  const resize = message.params?.[0];
  const tweetId = resize?.data?.tweet_id;
  const height = resize?.height;
  if (!/^\d+$/.test(tweetId ?? '') || !isSafeEmbedHeight(height)) return;

  const embed = document.querySelector(`iframe.tweet-embed[data-tweet-id="${tweetId}"]`);
  if (!embed || embed.contentWindow !== event.source) return;
  embed.style.height = `${Math.ceil(height)}px`;
}

function isSafeEmbedHeight(height) {
  return Number.isFinite(height) && height >= 200 && height <= 2000;
}

function initializeResultsDashboard() {
  const dashboard = document.querySelector('[data-results-dashboard]');
  if (!dashboard) return;

  const requestedResult = new URLSearchParams(location.search).get('result');
  const resultName = requestedResult && Object.hasOwn(publishedResults, requestedResult)
    ? requestedResult
    : 'polaris';
  const initialTab = dashboard.querySelector(`[data-dashboard-tab="${resultName}"]`);
  dashboard.querySelectorAll('[data-dashboard-tab]').forEach((tab) => {
    tab.addEventListener('click', () => selectPublishedResult(dashboard, tab, true));
  });
  selectPublishedResult(dashboard, initialTab, false);
  if (!motionDisabled) observeDashboardPlayback(dashboard);
}

function observeDashboardPlayback(dashboard) {
  const observer = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting || dashboard.dataset.played === 'true') return;
    dashboard.dataset.played = 'true';
    playDashboard(dashboard);
    observer.disconnect();
  }, {threshold: 0.2});
  observer.observe(dashboard);
}

function selectPublishedResult(dashboard, selectedTab, shouldPlay) {
  if (!selectedTab) return;
  const resultName = selectedTab.dataset.dashboardTab;
  const result = publishedResults[resultName];
  if (!result) return;

  window.clearInterval(Number(dashboard.dataset.playbackTimer));
  dashboard.dataset.result = resultName;
  updateDashboardTabs(dashboard, selectedTab);
  renderDashboardState(dashboard, result, result.values.length);
  if (shouldPlay && !motionDisabled) playDashboard(dashboard);
}

function playDashboard(dashboard) {
  const result = publishedResults[dashboard.dataset.result];
  if (!result) return;
  let visibleRuns = 1;
  dashboard.classList.add('is-live', 'is-resetting');
  renderDashboardState(dashboard, result, visibleRuns);
  setDashboardPlaybackState(dashboard, visibleRuns, false);
  void dashboard.offsetWidth;
  dashboard.classList.remove('is-resetting');

  const timer = window.setInterval(() => {
    visibleRuns += 1;
    renderDashboardState(dashboard, result, visibleRuns);
    const isComplete = visibleRuns >= result.values.length;
    setDashboardPlaybackState(dashboard, visibleRuns, isComplete);
    if (isComplete) window.clearInterval(timer);
  }, 360);
  dashboard.dataset.playbackTimer = String(timer);
}

function setDashboardPlaybackState(dashboard, visibleRuns, isComplete) {
  dashboard.classList.toggle('is-live', !isComplete);
  setText(dashboard, '[data-dashboard-state]', isComplete ? `Complete · ${visibleRuns} experiments` : `Running · experiment ${String(visibleRuns).padStart(2, '0')}`);
  if (isComplete) setText(dashboard, '[data-dashboard-announcement]', `Autoresearch complete. ${visibleRuns} experiments logged.`);
}

function updateDashboardTabs(dashboard, selectedTab) {
  dashboard.querySelectorAll('[data-dashboard-tab]').forEach((tab) => {
    const isSelected = tab === selectedTab;
    tab.classList.toggle('is-active', isSelected);
    tab.setAttribute('aria-selected', String(isSelected));
  });
}

function renderDashboardState(dashboard, result, visibleRuns) {
  const currentValues = result.values.slice(0, visibleRuns);
  const kept = result.statuses.slice(0, visibleRuns).filter((status) => status === 'keep').length;
  const bestIndex = Math.min(...currentValues);
  setText(dashboard, '[data-dashboard-subtitle]', result.subtitle);
  setText(dashboard, '[data-chart-label]', result.chartLabel);
  setText(dashboard, '[data-chart-change]', `−${100 - bestIndex}%`);
  setText(dashboard, '[data-card-label="0"]', 'Baseline → Best');
  setText(dashboard, '[data-card-value="0"]', formatDashboardRange(result, bestIndex));
  setText(dashboard, '[data-card-label="1"]', 'Improvement');
  setText(dashboard, '[data-card-value="1"]', `${100 - bestIndex}% faster`);
  setText(dashboard, '[data-card-label="2"]', 'Runs');
  setText(dashboard, '[data-card-value="2"]', String(visibleRuns));
  setText(dashboard, '[data-card-label="3"]', 'Kept');
  setText(dashboard, '[data-card-value="3"]', `${kept} / ${visibleRuns}`);
  renderDashboardRuns(dashboard, result, visibleRuns);
  updateDashboardChart(dashboard, result, visibleRuns);
  animateDashboardMetrics(dashboard);
}

function animateDashboardMetrics(dashboard) {
  if (motionDisabled || dashboard.classList.contains('is-resetting')) return;
  dashboard.querySelectorAll('.dashboard-cards strong').forEach((value) => {
    value.animate(
      [{opacity: 0.55, transform: 'translateY(3px)'}, {opacity: 1, transform: 'translateY(0)'}],
      {duration: 260, easing: 'ease-out'},
    );
  });
}

function formatDashboardRange(result, bestIndex) {
  if (!result.unit) return `100 → ${bestIndex}`;
  const bestValue = result.baselineValue * bestIndex / 100;
  return `${result.baselineValue.toFixed(1)}${result.unit} → ${bestValue.toFixed(2)}${result.unit}`;
}

function renderDashboardRuns(dashboard, result, visibleRuns) {
  const rows = dashboard.querySelector('[data-dashboard-run-rows]');
  if (!rows) return;
  rows.replaceChildren(...result.values.slice(0, visibleRuns).map((value, index) => dashboardRunRow(result, value, index)));
}

function dashboardRunRow(result, value, index) {
  const row = document.createElement('div');
  const status = result.statuses[index];
  const delta = index === 0 ? '—' : `−${100 - value}%`;
  row.className = `dashboard-result-row${index === result.values.length - 1 ? ' best-run' : ''}`;
  row.append(
    dashboardCell('strong', String(index + 1).padStart(2, '0')),
    dashboardCell('span', status, `run-status ${status}`),
    dashboardCell('span', String(value)),
    dashboardCell('span', delta, status === 'keep' && index > 0 ? 'dashboard-good' : ''),
    dashboardCell('span', result.descriptions[index]),
  );
  return row;
}

function dashboardCell(tagName, text, className = '') {
  const cell = document.createElement(tagName);
  cell.className = className;
  cell.textContent = text;
  return cell;
}

function updateDashboardChart(dashboard, result, visibleRuns) {
  const points = chartPointsFor(result.values, result.values.length);
  const linePath = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x} ${y}`).join(' ');
  const areaPath = `${linePath} L770 215 L40 215 Z`;
  const progress = (visibleRuns - 1) / (result.values.length - 1);
  dashboard.querySelector('[data-dashboard-line]').setAttribute('d', linePath);
  dashboard.querySelector('[data-dashboard-area]').setAttribute('d', areaPath);
  dashboard.querySelector('[data-dashboard-series]').style.clipPath = `inset(0 ${100 - progress * 100}% 0 0)`;
  renderChartPoints(dashboard, points, result.statuses, result.values, visibleRuns);
}

function chartPointsFor(values, totalRuns) {
  const step = 730 / (totalRuns - 1);
  return values.map((value, index) => [40 + index * step, 215 - value * 1.8]);
}

function renderChartPoints(dashboard, points, statuses, values, visibleRuns) {
  const group = dashboard.querySelector('[data-dashboard-points]');
  if (!group) return;
  const visibleValues = values.slice(0, visibleRuns);
  const bestValue = Math.min(...visibleValues.filter((_, index) => statuses[index] === 'keep'));
  if (group.children.length !== points.length) {
    group.replaceChildren(...points.map(() => document.createElementNS('http://www.w3.org/2000/svg', 'circle')));
  }
  [...group.children].forEach((circle, index) => {
    const [x, y] = points[index];
    const isVisible = index < visibleRuns;
    const isBest = isVisible && statuses[index] === 'keep' && values[index] === bestValue;
    circle.setAttribute('cx', String(x));
    circle.setAttribute('cy', String(y));
    circle.setAttribute('r', isBest ? '6' : '4');
    circle.classList.toggle('discard-point', statuses[index] === 'discard');
    circle.classList.toggle('best-point', isBest);
    circle.style.opacity = isVisible ? '1' : '0';
  });
}

function setText(scope, selector, value) {
  const element = scope.querySelector(selector);
  if (element) element.textContent = value;
}
