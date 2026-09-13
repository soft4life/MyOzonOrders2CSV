const detailTabs = new Set();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'OZON_ABORT_DETAIL_TABS') {
    const ids = [...detailTabs];
    detailTabs.clear();
    if (ids.length) chrome.tabs.remove(ids).catch(() => {});
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === 'OZON_DOWNLOAD_DATA_URL') {
    downloadDataUrl(message.dataUrl, message.filename)
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type !== 'OZON_PARSE_DETAIL_IN_TAB') return;
  parseDetailInTab(message.url, message.options || {}, sender.tab?.id)
    .then((detail) => sendResponse({ ok: true, detail }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function parseDetailInTab(url, options, sourceTabId) {
  const showTabs = Boolean(options.showTabs);
  const tab = await chrome.tabs.create({ url, active: showTabs });
  detailTabs.add(tab.id);
  try {
    await waitForComplete(tab.id, 20000);
    let lastDetail = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await wait(attempt === 0 ? 1200 : 500);
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'OZON_PARSE_OPEN_DETAIL' });
        if (response?.ok) {
          lastDetail = response.detail;
          if (lastDetail?.products?.length) break;
        }
      } catch {
        // Страница или content script ещё загружаются.
      }
    }
    if (!lastDetail) return null;
    const detailDate = lastDetail.orderDate || '';
    if ((options.dateFrom && detailDate && detailDate < options.dateFrom) ||
        (options.dateTo && detailDate && detailDate > options.dateTo)) {
      lastDetail.returnCheck = {
        returnCheck: 'skipped_outside_period', returnElementFound: Boolean(lastDetail.returnUrl),
        returnUrl: lastDetail.returnUrl || '', loadResult: 'not_opened', items: []
      };
      return lastDetail;
    }
    if (!lastDetail.returnUrl) {
      const closedStatus = /получен|доставлен|оставили\s+у\s+двери|возврат\s+заверш[её]н|(?:товар|деньги)\s+возвращ[её]н/i
        .test([lastDetail.status, ...(lastDetail.products || []).map((product) => product.status)].filter(Boolean).join(' '));
      lastDetail.returnCheck = {
        returnCheck: 'unavailable', returnElementFound: false, returnUrl: '',
        loadResult: 'not_opened', items: [],
        cacheable: Boolean(closedStatus && lastDetail.products?.length),
        cacheReason: closedStatus ? 'closed_without_return_action' : ''
      };
      return lastDetail;
    }

    try {
      await chrome.tabs.update(tab.id, { url: lastDetail.returnUrl });
      await waitForComplete(tab.id, 20000);
      let returnCheck = null;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await wait(attempt === 0 ? 1200 : 500);
        try {
          const response = await chrome.tabs.sendMessage(tab.id, { type: 'OZON_PARSE_OPEN_RETURN' });
          if (response?.ok) {
            returnCheck = response.returnCheck;
            if (returnCheck?.items?.length || returnCheck?.pageRecognized) break;
          }
        } catch {
          // Страница или content script ещё загружаются.
        }
      }
      lastDetail.returnCheck = returnCheck || {
        returnCheck: 'error', returnElementFound: true, returnUrl: lastDetail.returnUrl,
        loadResult: 'parse_timeout', items: [], error: 'Не удалось разобрать страницу возврата'
      };
      const terminalStates = new Set(['return_expired', 'return_unavailable']);
      const returnItems = lastDetail.returnCheck.items || [];
      const allItemsCovered = Boolean(
        lastDetail.products?.length && returnItems.length >= lastDetail.products.length
      );
      const returnStatusText = [
        lastDetail.status,
        ...(lastDetail.products || []).map((product) => product.status)
      ].filter(Boolean).join(' ');
      const explicitlyFullyReturned = /возврат\s+заверш[её]н|(?:товар|деньги)\s+возвращ[её]н/i.test(returnStatusText);
      const allItemsHaveReturnRequest = allItemsCovered &&
        returnItems.every((item) => item.returnState === 'return_requested');
      const allItemsTerminal = allItemsCovered &&
        returnItems.every((item) => terminalStates.has(item.returnState));
      lastDetail.returnCheck.cacheable = Boolean(
        lastDetail.returnCheck.returnCheck === 'completed' &&
        allItemsCovered &&
        (allItemsTerminal || allItemsHaveReturnRequest || explicitlyFullyReturned)
      );
      lastDetail.returnCheck.cacheReason = allItemsTerminal
        ? 'all_returns_expired_or_unavailable'
        : allItemsHaveReturnRequest
          ? 'all_items_have_return_request'
          : explicitlyFullyReturned
            ? 'fully_returned_status'
            : '';
    } catch (error) {
      lastDetail.returnCheck = {
        returnCheck: 'error', returnElementFound: true, returnUrl: lastDetail.returnUrl,
        loadResult: 'load_error', items: [], error: error.message
      };
    }
    return lastDetail;
  } finally {
    detailTabs.delete(tab.id);
    await chrome.tabs.remove(tab.id).catch(() => {});
    if (showTabs && sourceTabId) {
      await chrome.tabs.update(sourceTabId, { active: true }).catch(() => {});
    }
  }
}

function waitForComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Страница заказа загружалась слишком долго')), timeoutMs);
    const listener = (updatedId, changeInfo) => {
      if (updatedId === tabId && changeInfo.status === 'complete') finish();
    };
    const finish = (error) => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error); else resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((current) => {
      if (current.status === 'complete') finish();
    }).catch(() => finish(new Error('Вкладка заказа была закрыта')));
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


async function downloadDataUrl(dataUrl, filename) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    throw new Error('Некорректные данные для скачивания');
  }
  const safeFilename = String(filename || 'ozon_export.csv')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename: safeFilename || 'ozon_export.csv',
    saveAs: true,
    conflictAction: 'uniquify'
  });
  // download() only confirms that Chrome started the download.
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (!item) throw new Error('Chrome не нашёл загружаемый файл');
    if (item.state === 'complete') return downloadId;
    if (item.state === 'interrupted') {
      const reason = item.error || 'UNKNOWN';
      if (reason === 'FILE_ACCESS_DENIED') {
        throw new Error('Нет разрешения на запись в выбранную папку. Повторите сохранение и выберите другую папку.');
      }
      if (reason === 'USER_CANCELED') throw new Error('Сохранение отменено');
      throw new Error(`Chrome не сохранил файл: ${reason}`);
    }
    await wait(500);
  }
  throw new Error('Chrome не подтвердил сохранение за 5 минут. Проверьте список загрузок.');
}
