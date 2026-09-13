const button = document.querySelector('#exportButton');
const stopButton = document.querySelector('#stopButton');
const message = document.querySelector('#message');
const autoScroll = document.querySelector('#autoScroll');
const maxScrolls = document.querySelector('#maxScrolls');
const showTabs = document.querySelector('#showTabs');
const includeReturned = document.querySelector('#includeReturned');
const useCache = document.querySelector('#useCache');
const dateFrom = document.querySelector('#dateFrom');
const dateTo = document.querySelector('#dateTo');
const specificOrder = document.querySelector('#specificOrder');
const cacheInfo = document.querySelector('#cacheInfo');
const downloadCache = document.querySelector('#downloadCache');
const clearCache = document.querySelector('#clearCache');
const CACHE_PREFIX = 'obo-order-cache-v3:';
document.querySelector('#version').textContent = `v${chrome.runtime.getManifest().version}`;
let monitorTimer = null;

async function getCacheEntries() {
  const stored = await chrome.storage.local.get(null);
  return Object.entries(stored)
    .filter(([key, value]) => key.startsWith(CACHE_PREFIX) && value?.detail?.products?.length)
    .sort(([, left], [, right]) => String(left.orderNumber || '').localeCompare(String(right.orderNumber || '')));
}

async function refreshCacheInfo() {
  try {
    const entries = await getCacheEntries();
    const productCount = entries.reduce((sum, [, entry]) => sum + (entry.detail?.products?.length || 0), 0);
    cacheInfo.textContent = `Заказов: ${entries.length}, товарных позиций: ${productCount}`;
    downloadCache.disabled = entries.length === 0;
    clearCache.disabled = entries.length === 0;
  } catch (error) {
    cacheInfo.textContent = `Не удалось прочитать кэш: ${error.message}`;
    downloadCache.disabled = true;
    clearCache.disabled = true;
  }
}

function cacheFilename() {
  const now = new Date();
  const date = localIsoDate(now);
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((value) => String(value).padStart(2, '0')).join('-');
  return `ozon_order_cache_${date}_${time} (v${chrome.runtime.getManifest().version}).json`;
}

downloadCache.addEventListener('click', async () => {
  try {
    const entries = await getCacheEntries();
    if (!entries.length) throw new Error('Кэш пока пуст');
    const payload = {
      format: 'OzonMyOrders2csv order cache',
      cacheSchema: 3,
      extensionVersion: chrome.runtime.getManifest().version,
      exportedAt: new Date().toISOString(),
      orders: entries.map(([key, entry]) => ({ cacheKey: key, ...entry }))
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const dataUrl = await blobToDataUrl(blob);
    await chrome.downloads.download({
      url: dataUrl,
      filename: cacheFilename(),
      saveAs: false,
      conflictAction: 'uniquify'
    });
    message.classList.remove('error');
    message.textContent = `Кэш скачан: ${entries.length} заказов.`;
  } catch (error) {
    message.classList.add('error');
    message.textContent = error.message;
  }
});

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Не удалось подготовить файл для скачивания'));
    reader.readAsDataURL(blob);
  });
}

clearCache.addEventListener('click', async () => {
  const entries = await getCacheEntries().catch(() => []);
  if (!entries.length) return;
  const confirmed = window.confirm(`Удалить кэш закрытых заказов (${entries.length})? Даты и остальные настройки сохранятся.`);
  if (!confirmed) return;
  try {
    await chrome.storage.local.remove(entries.map(([key]) => key));
    message.classList.remove('error');
    message.textContent = `Кэш очищен: удалено заказов ${entries.length}.`;
    await refreshCacheInfo();
  } catch (error) {
    message.classList.add('error');
    message.textContent = `Не удалось очистить кэш: ${error.message}`;
  }
});

function localIsoDate(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

if (!dateTo.value) dateTo.value = localIsoDate();

async function restoreSettings() {
  const saved = await chrome.storage.local.get(['dateFrom', 'dateTo', 'showTabs', 'includeReturned', 'useCache']);
  if (Object.prototype.hasOwnProperty.call(saved, 'dateFrom')) dateFrom.value = saved.dateFrom;
  if (Object.prototype.hasOwnProperty.call(saved, 'dateTo')) dateTo.value = saved.dateTo;
  if (Object.prototype.hasOwnProperty.call(saved, 'showTabs')) showTabs.checked = Boolean(saved.showTabs);
  if (Object.prototype.hasOwnProperty.call(saved, 'includeReturned')) includeReturned.checked = Boolean(saved.includeReturned);
  if (Object.prototype.hasOwnProperty.call(saved, 'useCache')) useCache.checked = Boolean(saved.useCache);
}

function saveSettings() {
  return chrome.storage.local.set({
    dateFrom: dateFrom.value,
    dateTo: dateTo.value,
    showTabs: showTabs.checked,
    includeReturned: includeReturned.checked,
    useCache: useCache.checked
  });
}

dateFrom.addEventListener('change', saveSettings);
dateTo.addEventListener('change', saveSettings);
showTabs.addEventListener('change', saveSettings);
includeReturned.addEventListener('change', saveSettings);
useCache.addEventListener('change', saveSettings);
restoreSettings().catch(() => {});
refreshCacheInfo();

function syncExportMode() {
  const singleOrderMode = Boolean(specificOrder.value.trim());
  dateFrom.disabled = singleOrderMode;
  dateTo.disabled = singleOrderMode;
  autoScroll.disabled = singleOrderMode;
  maxScrolls.disabled = singleOrderMode || !autoScroll.checked;
}

autoScroll.addEventListener('change', syncExportMode);
specificOrder.addEventListener('input', syncExportMode);
syncExportMode();

function normalizeSpecificOrder(value) {
  const raw = String(value || '').trim();
  if (!raw) return { orderNumber: '', orderUrl: '' };

  if (/^[\d-]{6,}$/.test(raw)) {
    return {
      orderNumber: raw,
      orderUrl: `https://www.ozon.ru/my/orderdetails/?order=${encodeURIComponent(raw)}`
    };
  }

  try {
    const url = new URL(raw);
    if (!/(^|\.)ozon\.ru$/i.test(url.hostname)) throw new Error('not_ozon');
    const orderNumber = url.searchParams.get('order') || url.searchParams.get('orderNumber') ||
      url.searchParams.get('orderId') || url.pathname.match(/\/orderdetails\/(\d[\d-]{5,})/i)?.[1] || '';
    if (!orderNumber || !/^[\d-]{6,}$/.test(orderNumber)) throw new Error('no_order');
    return {
      orderNumber,
      orderUrl: `https://www.ozon.ru/my/orderdetails/?order=${encodeURIComponent(orderNumber)}`
    };
  } catch {
    throw new Error('Укажите номер заказа Ozon, например 34475857-0960, или полную ссылку на заказ.');
  }
}

async function getActiveOzonTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\/(www\.)?ozon\.ru\//i.test(tab.url || '')) {
    throw new Error('Сначала откройте любую страницу ozon.ru');
  }
  return tab;
}

function setRunningUi(running, statusText = '') {
  button.disabled = running;
  stopButton.disabled = false;
  stopButton.textContent = running ? 'Стоп' : 'Выйти';
  stopButton.dataset.mode = running ? 'stop' : 'exit';
  if (statusText) message.textContent = statusText;
}

async function refreshStatus() {
  try {
    const tab = await getActiveOzonTab();
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'OZON_EXPORT_STATUS' });
    setRunningUi(Boolean(response?.running), response?.lastMessage || '');
    return Boolean(response?.running);
  } catch {
    stopButton.disabled = true;
    return false;
  }
}

function startMonitoring() {
  clearInterval(monitorTimer);
  monitorTimer = setInterval(async () => {
    const running = await refreshStatus();
    if (!running) clearInterval(monitorTimer);
  }, 500);
}

button.addEventListener('click', async () => {
  message.classList.remove('error');

  let singleOrder = { orderNumber: '', orderUrl: '' };
  try {
    singleOrder = normalizeSpecificOrder(specificOrder.value);
  } catch (error) {
    message.classList.add('error');
    message.textContent = error.message;
    return;
  }

  if (!singleOrder.orderNumber && dateFrom.value && dateTo.value && dateFrom.value > dateTo.value) {
    message.classList.add('error');
    message.textContent = 'Дата «от» не может быть позже даты «до».';
    return;
  }

  message.textContent = singleOrder.orderNumber
    ? `Запускаю выгрузку заказа ${singleOrder.orderNumber}…`
    : 'Запускаю выгрузку…';
  setRunningUi(true);

  try {
    await saveSettings();
    const scrollLimit = Math.max(1, Math.min(100, Number.parseInt(maxScrolls.value, 10) || 5));
    maxScrolls.value = String(scrollLimit);
    const tab = await getActiveOzonTab();
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'OZON_EXPORT_ORDERS',
      options: {
        dateFrom: singleOrder.orderNumber ? '' : dateFrom.value,
        dateTo: singleOrder.orderNumber ? '' : dateTo.value,
        autoScroll: singleOrder.orderNumber ? false : autoScroll.checked,
        maxScrolls: singleOrder.orderNumber ? '' : scrollLimit,
        specificOrder: singleOrder.orderNumber,
        specificOrderUrl: singleOrder.orderUrl,
        showTabs: showTabs.checked,
        includeReturned: includeReturned.checked,
        useCache: useCache.checked
      }
    });

    if (!response?.ok) throw new Error(response?.error || 'Не удалось запустить экспорт');
    message.textContent = singleOrder.orderNumber
      ? `Экспорт заказа ${singleOrder.orderNumber} запущен.`
      : 'Экспорт запущен. Не закрывайте вкладку со списком заказов до завершения.';
    startMonitoring();
  } catch (error) {
    message.classList.add('error');
    message.textContent = error.message;
    setRunningUi(false);
  }
});

stopButton.addEventListener('click', async () => {
  if (stopButton.dataset.mode === 'exit') {
    window.close();
    return;
  }

  try {
    const tab = await getActiveOzonTab();
    await chrome.tabs.sendMessage(tab.id, { type: 'OZON_STOP_EXPORT' });
    message.classList.remove('error');
    message.textContent = 'Останавливаю выгрузку…';
    stopButton.disabled = true;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const status = await chrome.tabs.sendMessage(tab.id, { type: 'OZON_EXPORT_STATUS' });
      if (!status?.running) {
        setRunningUi(false, status?.lastMessage || 'Выгрузка остановлена. CSV не создан.');
        return;
      }
    }
    message.textContent = 'Команда остановки отправлена.';
  } catch (error) {
    message.classList.add('error');
    message.textContent = error.message;
    setRunningUi(false);
  }
});

refreshStatus().then((running) => {
  if (running) startMonitoring();
});
