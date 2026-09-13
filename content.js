(() => {
  const OVERLAY_ID = 'obo-export-overlay';
  const ORDER_CACHE_SCHEMA = 2;
  const ORDER_CACHE_PREFIX = `obo-order-cache-v${ORDER_CACHE_SCHEMA}:`;
  const CSV_COLUMNS = [
    'Дата заказа', 'Год', 'Месяц', 'Номер заказа', 'Статус', 'Статус возврата', 'Товар', 'Количество',
    'Цена товара', 'Реальная цена', 'Сумма заказа', 'Ссылка на товар', 'Ссылка на заказ'
  ];
  let running = false;
  let stopRequested = false;
  let lastMessage = '';
  let diagnostics = null;
  const activeControllers = new Set();
  let detailPreparationPromise = null;
  let returnPreparationPromise = null;

  window.addEventListener('beforeunload', (event) => {
    if (!running) return;
    event.preventDefault();
    event.returnValue = '';
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'OZON_PARSE_OPEN_DETAIL') {
      if (!detailPreparationPromise) detailPreparationPromise = prepareDetailPage();
      detailPreparationPromise
        .then((detail) => sendResponse({ ok: true, detail: detail || parseDetailDocument(document) }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type === 'OZON_PARSE_OPEN_RETURN') {
      if (!returnPreparationPromise) returnPreparationPromise = prepareReturnPage();
      returnPreparationPromise
        .then((returnCheck) => sendResponse({ ok: true, returnCheck }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type === 'OZON_EXPORT_STATUS') {
      sendResponse({ running, lastMessage });
      return;
    }

    if (message?.type === 'OZON_STOP_EXPORT') {
      stopRequested = true;
      addDiagnostic('info', 'Получена команда остановки');
      activeControllers.forEach((controller) => controller.abort());
      chrome.runtime.sendMessage({ type: 'OZON_ABORT_DETAIL_TABS' }).catch(() => {});
      updateOverlay('Останавливаю выгрузку…');
      sendResponse({ ok: true });
      return;
    }

    if (message?.type !== 'OZON_EXPORT_ORDERS') return;
    if (running) {
      sendResponse({ ok: false, error: 'Выгрузка уже выполняется' });
      return;
    }

    running = true;
    stopRequested = false;
    startDiagnostics(message.options || {});
    runExport(message.options || {})
      .catch((error) => {
        addDiagnostic('error', 'Необработанная ошибка выгрузки', { error: error.message, stack: error.stack || '' });
        updateOverlay(`Ошибка: ${error.message}`, true);
      })
      .finally(() => {
        running = false;
        stopRequested = false;
      });
    sendResponse({ ok: true });
  });

  async function runExport(options) {
    createOverlay();
    addDiagnostic('info', 'Выгрузка запущена');
    updateOverlay('Проверяю страницу заказов…');

    if (!/\/my\/order/i.test(location.pathname)) {
      updateOverlay('Откройте раздел Ozon → Заказы и запустите экспорт снова.', true);
      return;
    }

    const captured = options.autoScroll
      ? await loadAllOrders(options)
      : { rows: [], orderKeys: [] };

    addDiagnostic('info', 'Список заказов собран', {
      rows: captured.rows.length,
      orderKeys: captured.orderKeys.length,
      earliestDate: captured.earliestDate || '',
      earliestReceiptDate: captured.earliestReceiptDate || '',
      scrollLimitReached: Boolean(captured.scrollLimitReached),
      stoppedByReceiptDate: Boolean(captured.stoppedByReceiptDate)
    });

    if (stopRequested) {
      await offerStoppedExport(captured.rows, 'Загрузка списка заказов');
      return;
    }

    updateOverlay('Собираю товары и суммы…');
    const current = collectOrders(options, Boolean(options.autoScroll));
    const baseRows = uniqueBy([...captured.rows, ...current.rows], (row) => JSON.stringify(row));
    if (!baseRows.length) {
      updateOverlay('Заказы не найдены. Прокрутите страницу вручную и повторите экспорт.', true);
      return;
    }

    const result = await enrichOrders(baseRows, options);
    if (stopRequested) {
      await offerStoppedExport(result.rows, 'Получение состава заказов', {
        returnedQuantity: result.returnedQuantity,
        excludedReturns: result.excludedReturns,
        cacheHits: result.cacheHits,
        cacheWrites: result.cacheWrites
      });
      return;
    }
    if (!result.rows.length) {
      updateOverlay('По выбранному периоду после исключения отмен и возвратов заказов не найдено.', true);
      return;
    }

    const csv = makeCsv(result.rows, options, {
      orders: result.orders,
      rows: result.rows.length,
      excludedReturns: result.excludedReturns,
      returnedQuantity: result.returnedQuantity,
      cacheHits: result.cacheHits,
      cacheWrites: result.cacheWrites,
      stopReason: captured.stoppedByReceiptDate
        ? 'Диапазон просмотрен полностью: в списке начались товары, полученные раньше даты «от». Ничего исправлять не нужно.'
        : (captured.scrollLimitReached
          ? 'Достигнут лимит прокруток. Если нужные заказы не попали в файл, увеличьте лимит до 100 и повторите выгрузку.'
          : 'Достигнут конец списка заказов. Ничего исправлять не нужно.')
    });
    downloadCsv(csv, buildExportFilename(options));
    const limitedBeforeRange = captured.scrollLimitReached && options.dateFrom &&
      (!captured.earliestDate || captured.earliestDate > options.dateFrom);
    updateOverlay(
      `Готово: ${result.orders} заказов, ${result.rows.length} строк, из кэша: ${result.cacheHits}, сохранено в кэш: ${result.cacheWrites}, исключено возвратов: ${result.excludedReturns}. CSV скачан.` +
      (limitedBeforeRange ? ' Достигнут лимит прокруток раньше даты «от» — для полного периода увеличьте его.' : '')
    );
  }

  async function enrichOrders(baseRows, options) {
    const groups = new Map();
    for (const row of baseRows) {
      const key = row['Ссылка на заказ'] || row['Номер заказа'];
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }

    const entries = [...groups.entries()];
    const details = new Map();
    let completed = 0;
    let processed = 0;
    let cacheHits = 0;
    let cacheWrites = 0;
    const totalEntries = entries.length;

    // Ozon mixes dates in the order list, so every loaded non-cancelled card must
    // be checked. The user-controlled scroll limit bounds the size of this set.
    const detailConcurrency = options.showTabs ? 1 : 2;
    await mapWithLimit(entries, detailConcurrency, async ([key, rows]) => {
      if (stopRequested) return;
      const base = chooseBestBaseRow(rows);
      const baseDate = base['Дата заказа'];

      if ((options.dateFrom && baseDate && baseDate < options.dateFrom) ||
          (options.dateTo && baseDate && baseDate > options.dateTo)) {
        processed += 1;
        updateOverlay(`Получаю состав заказов: проверено ${processed} из ${totalEntries}, вне периода`);
        return;
      }

      const url = base['Ссылка на заказ'];
      let detail = options.useCache === false ? null : await readCachedOrder(base);
      const fromCache = Boolean(detail);
      if (fromCache) {
        cacheHits += 1;
        addDiagnostic('info', 'Заказ получен из кэша', {
          orderNumber: base['Номер заказа'],
          orderUrl: url
        });
      } else {
        if (options.useCache === false) {
          addDiagnostic('info', 'Кэш пропущен по настройке — заказ перечитывается', {
            orderNumber: base['Номер заказа'],
            orderUrl: url
          });
        }
        detail = url ? await fetchOrderDetail(url, options) : null;
        if (detail?.returnCheck?.cacheable && detail.products?.length) {
          const saved = await writeCachedOrder(base, detail);
          if (saved) cacheWrites += 1;
        }
      }
      details.set(key, detail);
      completed += 1;

      if (!detail) {
        addDiagnostic('warning', 'Не удалось получить страницу заказа', {
          orderNumber: base['Номер заказа'],
          orderUrl: url
        });
      } else if (!detail.products?.length) {
        addDiagnostic('warning', 'На странице заказа не найдены товары', {
          orderNumber: base['Номер заказа'],
          orderUrl: url,
          orderDate: detail.orderDate || baseDate || ''
        });
      }
      if (detail?.returnCheck) addReturnDiagnostic(base, detail, options);

      const resolvedDate = detail?.orderDate || baseDate;
      processed += 1;
      updateOverlay(
        `Получаю состав заказов: проверено ${processed} из ${totalEntries}${fromCache ? ', из кэша' : ''}${resolvedDate ? `, дата ${resolvedDate}` : ''}`
      );
    });

    const output = [];
    const orderKeys = new Set();
    let excludedReturns = 0;
    let returnedQuantity = 0;
    for (const [key, rows] of entries) {
      if (!details.has(key)) continue;
      const base = chooseBestBaseRow(rows);
      const detail = details.get(key);
      const status = detail?.status || base['Статус'];
      const orderDate = detail?.orderDate || base['Дата заказа'];

      const common = {
        orderNumber: base['Номер заказа'],
        orderDate,
        orderUrl: base['Ссылка на заказ'],
        total: OzonReturnTools.calculateOrderTotal(detail || {}, detail?.total || base['Сумма заказа']),
        goodsTotal: detail?.goodsTotal || '',
        bonusPayment: detail?.bonusPayment || '',
        deliveryTotal: detail?.deliveryTotal || ''
      };

      let added = false;
      if (detail?.products?.length) {
        const productsWithRealPrices = OzonReturnTools.addRealPrices(detail.products, detail);
        const checked = OzonReturnTools.filterReturnedProducts(productsWithRealPrices, detail.returnCheck, {
          includeReturned: Boolean(options.includeReturned)
        });
        excludedReturns += checked.report.excludedProducts || 0;
        returnedQuantity += checked.report.returnedQuantity || 0;
        for (const product of checked.products) {
          const productStatus = product.status || status;
          if (!passesFilters(orderDate, productStatus, options, true)) continue;
          output.push(buildRow({ ...common, ...product, status: productStatus }));
          added = true;
        }
      } else {
        const existingProducts = rows.filter((row) => row['Товар']);
        if (existingProducts.length) {
          const allowed = existingProducts.filter((row) => passesFilters(orderDate, row['Статус'] || status, options, true));
          output.push(...allowed);
          added = allowed.length > 0;
        } else if (passesFilters(orderDate, status, options, true)) {
          output.push(buildRow({ ...common, status }));
          added = true;
        }
      }
      if (added) orderKeys.add(common.orderNumber || common.orderUrl || key);
    }

    return {
      rows: uniqueBy(output, (row) => JSON.stringify(row)),
      orders: orderKeys.size,
      checked: completed,
      excludedReturns,
      returnedQuantity,
      cacheHits,
      cacheWrites
    };
  }

  function orderCacheKey(base) {
    const identity = clean(base?.['Номер заказа'] || base?.['Ссылка на заказ']);
    if (!identity) return '';
    return ORDER_CACHE_PREFIX + encodeURIComponent(identity);
  }

  async function readCachedOrder(base) {
    const key = orderCacheKey(base);
    if (!key) return null;
    try {
      const stored = await chrome.storage.local.get(key);
      const entry = stored?.[key];
      if (entry?.schema !== ORDER_CACHE_SCHEMA || !entry.detail?.products?.length || !entry.detail?.returnCheck?.cacheable) {
        return null;
      }
      return entry.detail;
    } catch (error) {
      addDiagnostic('warning', 'Не удалось прочитать кэш заказа', { error: error.message });
      return null;
    }
  }

  async function writeCachedOrder(base, detail) {
    const key = orderCacheKey(base);
    if (!key) return false;
    try {
      await chrome.storage.local.set({
        [key]: {
          schema: ORDER_CACHE_SCHEMA,
          cachedAt: new Date().toISOString(),
          orderNumber: base?.['Номер заказа'] || '',
          orderUrl: base?.['Ссылка на заказ'] || '',
          detail
        }
      });
      addDiagnostic('info', 'Закрытый заказ сохранён в кэш', {
        orderNumber: base?.['Номер заказа'] || '',
        products: detail.products.length
      });
      return true;
    } catch (error) {
      addDiagnostic('warning', 'Не удалось сохранить заказ в кэш', {
        orderNumber: base?.['Номер заказа'] || '',
        error: error.message
      });
      return false;
    }
  }

  async function fetchOrderDetail(orderUrl, options) {
    try {
      const rendered = await chrome.runtime.sendMessage({
        type: 'OZON_PARSE_DETAIL_IN_TAB',
        url: orderUrl,
        options: {
          dateFrom: options.dateFrom || '',
          dateTo: options.dateTo || '',
          showTabs: Boolean(options.showTabs)
        }
      });
      if (rendered?.ok && rendered.detail?.products?.length) return rendered.detail;
      if (!rendered?.ok) {
        addDiagnostic('warning', 'Фоновая вкладка заказа вернула ошибку', {
          orderUrl,
          error: rendered?.error || 'Неизвестная ошибка'
        });
      }
    } catch (error) {
      addDiagnostic('warning', 'Не удалось прочитать фоновую вкладку заказа', {
        orderUrl,
        error: error.message
      });
      // Если фоновая вкладка недоступна, ниже используются запросы страницы.
    }

    let composerDetail = null;
    try {
      const parsedUrl = new URL(orderUrl);
      const relativeUrl = `${parsedUrl.pathname}${parsedUrl.search}`;
      const composerUrl = `${location.origin}/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(relativeUrl)}`;
      const composerResponse = await fetchWithStop(composerUrl, { credentials: 'include', cache: 'no-store' });
      if (composerResponse.ok) {
        const json = await composerResponse.json();
        composerDetail = parseComposerDetail(json);
        if (composerDetail.products.length && composerDetail.products.every((product) => product.status) && composerDetail.orderDate) {
          return composerDetail;
        }
      }
    } catch (error) {
      addDiagnostic('warning', 'Ошибка резервного API страницы заказа', {
        orderUrl,
        error: error.message
      });
      // Ниже используется запасной разбор HTML страницы заказа.
    }

    try {
      const response = await fetchWithStop(orderUrl, { credentials: 'include', cache: 'no-store' });
      if (!response.ok) return composerDetail;
      const htmlDetail = parseDetailHtml(await response.text());
      return {
        status: htmlDetail.status || composerDetail?.status || '',
        orderDate: htmlDetail.orderDate || composerDetail?.orderDate || '',
        total: htmlDetail.total || composerDetail?.total || '',
        goodsTotal: htmlDetail.goodsTotal || composerDetail?.goodsTotal || '',
        bonusPayment: htmlDetail.bonusPayment || composerDetail?.bonusPayment || '',
        deliveryTotal: htmlDetail.deliveryTotal || composerDetail?.deliveryTotal || '',
        products: htmlDetail.products.length ? htmlDetail.products : (composerDetail?.products || [])
      };
    } catch (error) {
      addDiagnostic('error', 'Ошибка загрузки HTML страницы заказа', {
        orderUrl,
        error: error.message
      });
      return composerDetail;
    }
  }

  async function fetchWithStop(url, options) {
    const controller = new AbortController();
    activeControllers.add(controller);
    if (stopRequested) controller.abort();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
      activeControllers.delete(controller);
    }
  }

  function parseDetailHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return parseDetailDocument(doc);
  }

  async function prepareDetailPage() {
    if (!/\/my\/orderdetails/i.test(location.pathname)) return parseDetailDocument(document);

    const scrolling = document.scrollingElement || document.documentElement;
    let previousTop = -1;
    let stableRounds = 0;
    const snapshots = [];

    const capture = () => snapshots.push(parseDetailDocument(document));
    const finish = () => {
      capture();
      return mergeDetailSnapshots(snapshots);
    };

    capture();

    for (let step = 0; step < 60; step += 1) {
      const boundary = findRecommendationHeading(document);
      const viewportHeight = Math.max(window.innerHeight || 0, 600);

      if (boundary) {
        const boundaryTop = boundary.getBoundingClientRect().top;
        if (boundaryTop >= 0 && boundaryTop <= viewportHeight * 1.15) {
          await wait(500);
          return finish();
        }
      }

      const currentTop = scrolling.scrollTop;
      const maximumTop = Math.max(0, scrolling.scrollHeight - viewportHeight);
      const nextTop = Math.min(maximumTop, currentTop + Math.max(450, Math.floor(viewportHeight * 0.72)));
      window.scrollTo({ top: nextTop, behavior: 'auto' });
      await wait(350);
      capture();

      const actualTop = scrolling.scrollTop;
      if (actualTop === previousTop || (actualTop >= maximumTop && nextTop >= maximumTop)) stableRounds += 1;
      else stableRounds = 0;
      previousTop = actualTop;
      if (stableRounds >= 3) return finish();
    }
    return finish();
  }

  function mergeDetailSnapshots(snapshots) {
    const latest = snapshots[snapshots.length - 1] || {};
    const firstWith = (field) => snapshots.find((item) => item?.[field])?.[field] || '';
    return {
      status: latest.status || firstWith('status'),
      orderDate: latest.orderDate || firstWith('orderDate'),
      total: latest.total || firstWith('total'),
      goodsTotal: latest.goodsTotal || firstWith('goodsTotal'),
      bonusPayment: latest.bonusPayment || firstWith('bonusPayment'),
      deliveryTotal: latest.deliveryTotal || firstWith('deliveryTotal'),
      returnUrl: latest.returnUrl || firstWith('returnUrl'),
      products: mergeProducts(snapshots.flatMap((item) => item?.products || []))
    };
  }

  function parseDetailDocument(doc) {
    const lines = [...doc.querySelectorAll('div,span,p,h1,h2,h3')]
      .map((node) => clean(node.textContent))
      .filter((line) => line.length && line.length < 140);
    const fullText = clean(doc.body?.textContent);
    const status = extractStatus(lines.join('\n'));
    const linkedProducts = [...doc.querySelectorAll('a[href*="/product/"]')]
        .filter((anchor) => isBeforeRecommendationBoundary(anchor, doc) && !isInsideRecommendations(anchor, doc.body))
        .map((anchor) => productFromAnchor(anchor, doc.body))
        .filter((product) => product.product);
    const products = mergeProducts([...linkedProducts, ...extractProductsByPrice(doc.body)]);

    return {
      status,
      orderDate: extractOrderDate(fullText),
      total: extractMoneyAfterLabel(fullText, ['Итого', 'Сумма заказа', 'Оплачено']),
      goodsTotal: extractMoneyAfterLabel(fullText, ['Товары']),
      bonusPayment: extractMoneyAfterLabel(fullText, ['Оплата баллами Ozon']),
      deliveryTotal: extractMoneyAfterLabel(fullText, ['Доставка']),
      returnUrl: findReturnUrl(doc),
      products
    };
  }

  function findReturnUrl(doc) {
    const controls = [...doc.querySelectorAll('a,button,div,span,[role="button"]')];
    const control = controls.find((node) => {
      if (!/^вернуть\s+товары$/i.test(clean(node.textContent))) return false;
      return ![...node.children].some((child) => /^вернуть\s+товары$/i.test(clean(child.textContent)));
    });
    if (!control) return '';
    const href = control.closest('a[href]')?.getAttribute('href') || control.getAttribute('href') || '';
    if (href) return absoluteUrl(href);
    const current = doc.location?.href || location.href;
    try {
      const parsed = new URL(current);
      const orderNumber = parsed.searchParams.get('order') || parsed.searchParams.get('orderNumber') ||
        clean(doc.body?.textContent).match(/(?:№|заказ\s*№?)\s*([\d-]{6,})/i)?.[1] || '';
      return orderNumber
        ? `${parsed.origin}/my/returnCreation/items?orderNumber=${encodeURIComponent(orderNumber)}`
        : '';
    } catch {
      return '';
    }
  }

  async function prepareReturnPage() {
    const returnUrl = location.href;
    if (!/\/my\/returnCreation\/items/i.test(location.pathname)) {
      return {
        returnCheck: 'error', returnElementFound: true, returnUrl,
        loadResult: 'unexpected_page', pageRecognized: false, items: []
      };
    }

    const scrolling = document.scrollingElement || document.documentElement;
    const snapshots = [];
    let previousHeight = -1;
    let stableRounds = 0;
    window.scrollTo({ top: 0, behavior: 'auto' });
    await wait(350);

    for (let step = 0; step < 30; step += 1) {
      snapshots.push(parseReturnDocument(document));
      window.scrollTo({ top: scrolling.scrollHeight, behavior: 'auto' });
      await wait(300);
      const height = scrolling.scrollHeight;
      if (height === previousHeight) stableRounds += 1; else stableRounds = 0;
      previousHeight = height;
      if (stableRounds >= 3) break;
    }
    snapshots.push(parseReturnDocument(document));
    const allItems = uniqueBy(
      snapshots.flatMap((snapshot) => snapshot.items),
      (item) => `${item.productId}|${item.productUrl}|${item.product}|${item.price}|${item.returnState}`
    );
    const pageRecognized = snapshots.some((snapshot) => snapshot.pageRecognized);
    const markerCount = Math.max(0, ...snapshots.map((snapshot) => snapshot.markerCount || 0));
    const parseFailed = markerCount > 0 && allItems.length === 0;
    return {
      returnCheck: pageRecognized && !parseFailed ? 'completed' : 'error',
      returnElementFound: true,
      returnUrl,
      loadResult: parseFailed ? 'markers_not_parsed' : (pageRecognized ? 'loaded' : 'unrecognized'),
      pageRecognized,
      markerCount,
      items: allItems
    };
  }

  function parseReturnDocument(doc) {
    const bodyText = clean(doc.body?.textContent);
    const pageRecognized = /возврат\s+товара|выберите\s+товар|причина\s+и\s+фото/i.test(bodyText);
    const statePattern = /уже\s+есть\s+заявка\s+на\s+возврат|создать\s+заявку\s+можно\s+до|срок\s+возврата\s+ист[её]к|товар\s+нельзя\s+вернуть/i;
    const stateNodes = [...doc.querySelectorAll('div,span,p,small')]
      .filter((node) => statePattern.test(clean(node.textContent)))
      .filter((node) => ![...node.children].some((child) => statePattern.test(clean(child.textContent))));
    const items = [];

    for (const stateNode of stateNodes) {
      const stateText = clean(stateNode.textContent);
      const box = findReturnProductBox(stateNode, doc.body);
      if (!box) continue;
      const text = clean(box.textContent);
      const anchor = box.querySelector('a[href*="/product/"]');
      const productUrl = anchor ? absoluteUrl(anchor.getAttribute('href')) : '';
      const product = findReturnProductName(box, stateNode);
      if (!product) continue;
      items.push({
        product,
        productUrl,
        productId: OzonReturnTools.productId(productUrl),
        price: extractBestPrice(text),
        quantity: extractQuantity(text),
        returnedQuantity: extractReturnedQuantity(text),
        returnState: /уже\s+есть\s+заявка\s+на\s+возврат/i.test(stateText)
          ? 'return_requested'
          : /срок\s+возврата\s+ист[её]к/i.test(stateText)
            ? 'return_expired'
            : /товар\s+нельзя\s+вернуть/i.test(stateText)
              ? 'return_unavailable'
              : 'return_available'
      });
    }
    return { pageRecognized, markerCount: stateNodes.length, items };
  }

  function findReturnProductBox(start, root) {
    let node = start.parentElement;
    let best = null;
    for (let depth = 0; node && node !== root && depth < 9; depth += 1, node = node.parentElement) {
      const text = clean(node.textContent);
      const stateCount = (text.match(/уже\s+есть\s+заявка\s+на\s+возврат|создать\s+заявку\s+можно\s+до|срок\s+возврата\s+ист[её]к|товар\s+нельзя\s+вернуть/gi) || []).length;
      if (node.querySelector('img') && /\d[\d\s.,]*\s*(?:₽|руб\.?)/i.test(text) && stateCount === 1) return node;
      if (stateCount > 1) break;
    }
    return best;
  }

  function findReturnProductName(box, stateNode) {
    const imageAlt = clean(box.querySelector('img[alt]')?.getAttribute('alt'));
    if (isLikelyProductName(imageAlt)) return imageAlt;
    const rejected = /доставка\s+\d|создать\s+заявку|уже\s+есть\s+заявка|срок\s+возврата|товар\s+нельзя\s+вернуть|возврат\s+товара|продолжить/i;
    const candidates = [...box.querySelectorAll('a,span,p,div')]
      .filter((node) => !node.children.length && node !== stateNode)
      .map((node) => clean(node.textContent))
      .filter((value) => isLikelyProductName(value) && !rejected.test(value))
      .sort((a, b) => b.length - a.length);
    return candidates[0] || '';
  }

  function extractReturnedQuantity(text) {
    return text.match(/(?:возвращено|в\s+заявке)\s*[:—-]?\s*(\d+)\s*(?:шт\.?)?/i)?.[1] || '';
  }

  function parseComposerDetail(data) {
    const unpacked = [];
    unpackJson(data, unpacked, 0);
    const products = [];
    const strings = [];

    for (const value of unpacked) {
      if (typeof value === 'string') strings.push(value);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;

      const keys = Object.keys(value);
      if (keys.length > 60) continue;
      const productUrl = findString(value, (item) => /\/product\//i.test(item), 3);
      const productId = findValueByKey(value, /^(?:productId|sku|offerId|itemId)$/i, 2);
      const imageUrl = findString(value, (item) => /(?:cdn|image|img|\.jpg|\.png|\.webp)/i.test(item), 3);
      const rawPrice = findValueByKey(value, /^(?:finalPrice|currentPrice|salePrice|price|amount)$/i, 2) ||
        findString(value, (item) => /^\s*\d[\d\s.,]*\s*(?:₽|руб\.?)/i.test(item), 2);
      const rawQuantity = findValueByKey(value, /^(?:quantity|count|itemsCount)$/i, 2);
      const namedProduct = findValueByKey(value, /^(?:productName|title|name|caption)$/i, 2);
      const product = typeof namedProduct === 'string' && isLikelyProductName(namedProduct)
        ? namedProduct
        : findLikelyProductName(value, 2);
      const hasProductHint = keys.some((key) => /product|sku|offer|item|good/i.test(key)) ||
        Boolean(productUrl || productId || imageUrl || rawQuantity);
      if (!hasProductHint || !product || rawPrice === '') continue;

      const rawStatus = findValueByKey(value, /^(?:status|state|deliveryStatus|postingStatus)$/i, 2);
      products.push({
        product: clean(product),
        productUrl: productUrl ? absoluteUrl(productUrl) : '',
        quantity: normalizeQuantity(rawQuantity),
        price: normalizePriceValue(rawPrice),
        status: normalizeStatusValue(rawStatus)
      });
    }

    const joined = strings.filter((item) => typeof item === 'string' && item.length < 300).join('\n');
    return {
      status: extractStatus(joined),
      orderDate: extractOrderDate(joined),
      total: extractMoneyAfterLabel(clean(joined), ['Итого', 'Сумма заказа', 'Оплачено']),
      goodsTotal: extractMoneyAfterLabel(clean(joined), ['Товары']),
      bonusPayment: extractMoneyAfterLabel(clean(joined), ['Оплата баллами Ozon']),
      deliveryTotal: extractMoneyAfterLabel(clean(joined), ['Доставка']),
      products: uniqueBy(products, (product) => `${product.productUrl}|${product.product}|${product.price}`)
    };
  }

  function productFromAnchor(anchor, root) {
    const product = clean(
      anchor.textContent ||
      anchor.getAttribute('aria-label') ||
      anchor.querySelector('img')?.getAttribute('alt')
    );
    const box = findProductBox(anchor, root);
    const pricingBox = findPricingContext(box, root);
    const text = clean(pricingBox?.textContent || box?.textContent || product);
    return {
      product,
      productUrl: absoluteUrl(anchor.getAttribute('href')),
      quantity: extractQuantity(text),
      price: extractBestPrice(text),
      status: findProductSectionStatus(anchor, root)
    };
  }

  function extractProductsByPrice(root) {
    if (!root?.querySelectorAll) return [];
    const priceNodes = [...root.querySelectorAll('span,div,p')].filter((node) => {
      if (node.children?.length) return false;
      return /^\s*\d[\d\s.,]*\s*(?:₽|руб\.?)\s*$/i.test(clean(node.textContent));
    });
    const products = [];

    for (const priceNode of priceNodes) {
      if (!isBeforeRecommendationBoundary(priceNode, root.ownerDocument || document)) continue;
      if (isInsideRecommendations(priceNode, root)) continue;
      let node = priceNode.parentElement;
      for (let depth = 0; node && node !== root && depth < 7; depth += 1, node = node.parentElement) {
        const product = findLikelyProductNameInNode(node);
        const hasImage = Boolean(node.querySelector?.('img'));
        const hasProductAction = /в корзину|похожие товары|купить/i.test(clean(node.textContent));
        if (product && (hasImage || hasProductAction)) {
          const pricingBox = findPricingContext(node, root);
          const pricingText = clean(pricingBox?.textContent || node.textContent);
          const productHref = node.querySelector?.('a[href*="/product/"]')?.getAttribute('href') || '';
          products.push({
            product,
            productUrl: productHref ? absoluteUrl(productHref) : '',
            quantity: extractQuantity(pricingText),
            price: extractBestPrice(pricingText),
            status: findProductSectionStatus(node, root)
          });
          break;
        }
      }
    }
    return uniqueBy(products, (product) => `${product.product}|${product.price}|${product.productUrl}`);
  }

  function findLikelyProductNameInNode(node) {
    const candidates = [...node.querySelectorAll('a,span,p,div')]
      .filter((item) => !item.children?.length)
      .map((item) => clean(item.textContent))
      .filter(isLikelyProductName)
      .sort((a, b) => b.length - a.length);
    return candidates[0] || '';
  }

  function findLikelyProductName(value, depth) {
    const strings = [];
    collectShallowStrings(value, depth, strings);
    return strings.filter(isLikelyProductName).sort((a, b) => b.length - a.length)[0] || '';
  }

  function collectShallowStrings(value, depth, output) {
    if (depth < 0 || value == null) return;
    if (typeof value === 'string') {
      output.push(clean(value));
      return;
    }
    if (typeof value !== 'object') return;
    Object.values(value).forEach((child) => collectShallowStrings(child, depth - 1, output));
  }

  function isLikelyProductName(value) {
    const text = clean(value);
    if (text.length < 8 || text.length > 500) return false;
    if (/^(?:https?:|\/|data:)/i.test(text)) return false;
    if (/^\d[\d\s.,]*\s*(?:₽|руб\.?|шт\.?)?$/i.test(text)) return false;
    if (/^(?:получен|доставлен|оставили у двери|отмен[её]н|возврат|в пути|ожидает|доставим|готов к выдаче|итого|оплачено|сумма заказа|в корзину|похожие товары|купить)$/i.test(text)) return false;
    return /[а-яa-z]{3}/i.test(text);
  }

  function findProductSectionStatus(anchor, root) {
    let node = anchor;
    for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) {
      if (nodeContainsRecommendationHeading(node)) return '';
      const status = extractStatusFromNode(node);
      if (status) return status;
      if (node === root) break;
    }
    return '';
  }

  function isInsideRecommendations(start, root) {
    let node = start;
    for (let depth = 0; node && depth < 14; depth += 1, node = node.parentElement) {
      if (extractStatusFromNode(node)) return false;
      if (nodeContainsRecommendationHeading(node)) return true;
      if (node === root) break;
    }
    return false;
  }

  function nodeContainsRecommendationHeading(node) {
    return [...(node.querySelectorAll?.('h1,h2,h3,h4') || [])]
      .some((heading) => isRecommendationText(heading.textContent));
  }

  function findRecommendationHeading(doc) {
    return [...doc.querySelectorAll('h1,h2,h3,h4')]
      .find((heading) => isRecommendationText(heading.textContent)) || null;
  }

  function isRecommendationText(value) {
    return /рекомендации(?:\s+к\s+вашим\s+покупкам)?|подобрали\s+по\s+вашим\s+интересам/i.test(clean(value));
  }

  function isBeforeRecommendationBoundary(node, doc) {
    const boundary = findRecommendationHeading(doc);
    if (!boundary || node === boundary) return !boundary;
    return Boolean(node.compareDocumentPosition(boundary) & 4);
  }

  function extractStatusFromNode(node) {
    const candidates = [node, ...(node.querySelectorAll?.('h1,h2,h3,h4,p,span,div') || [])]
      .map((item) => clean(item.textContent))
      .filter((line) => line.length && line.length < 120);
    return extractStatus(candidates.join('\n'));
  }

  function unpackJson(value, output, depth) {
    if (depth > 12 || value == null) return;
    output.push(value);
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length < 2000000) {
        try { unpackJson(JSON.parse(trimmed), output, depth + 1); } catch { /* Не JSON. */ }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => unpackJson(item, output, depth + 1));
      return;
    }
    if (typeof value === 'object') {
      Object.values(value).forEach((item) => unpackJson(item, output, depth + 1));
    }
  }

  function findString(value, predicate, depth) {
    if (depth < 0 || value == null) return '';
    if (typeof value === 'string') return predicate(value) ? value : '';
    if (typeof value !== 'object') return '';
    for (const child of Object.values(value)) {
      const result = findString(child, predicate, depth - 1);
      if (result) return result;
    }
    return '';
  }

  function findValueByKey(value, pattern, depth) {
    if (depth < 0 || !value || typeof value !== 'object') return '';
    for (const [key, child] of Object.entries(value)) {
      if (pattern.test(key) && (typeof child === 'string' || typeof child === 'number')) return child;
    }
    for (const child of Object.values(value)) {
      const result = findValueByKey(child, pattern, depth - 1);
      if (result !== '') return result;
    }
    return '';
  }

  async function mapWithLimit(items, limit, worker) {
    let index = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length && !stopRequested) {
        const current = items[index];
        index += 1;
        await worker(current);
        await wait(120);
      }
    });
    await Promise.all(runners);
  }

  function chooseBestBaseRow(rows) {
    return [...rows].sort((a, b) => rowScore(b) - rowScore(a))[0];
  }

  function rowScore(row) {
    return Object.values(row).filter(Boolean).length;
  }

  function normalizeQuantity(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? String(number) : '1';
  }

  function normalizePriceValue(value) {
    if (typeof value === 'number') return String(value);
    const match = String(value || '').match(/\d[\d\s]*[.,]?\d{0,2}/);
    return match ? normalizeMoney(match[0]) : '';
  }

  function normalizeStatusValue(value) {
    const raw = clean(value);
    if (!raw) return '';
    const visible = extractStatus(raw);
    if (visible) return visible;
    if (/cancel/i.test(raw)) return 'Отменён';
    if (/return|refund/i.test(raw)) return 'Возврат оформлен';
    if (/deliver|received|completed/i.test(raw)) return 'Доставлен';
    return '';
  }

  async function loadAllOrders(options) {
    let stableRounds = 0;
    let previousTop = -1;
    const rows = [];
    const orderKeys = [];
    const maxScrolls = Math.max(1, Math.min(100, Number.parseInt(options.maxScrolls, 10) || 5));
    let scrollLimitReached = false;
    let stoppedByReceiptDate = false;
    let olderReceiptRounds = 0;
    const receiptDates = [];

    window.scrollTo({ top: 0, behavior: 'auto' });
    await wait(600);

    for (let round = 0; round <= maxScrolls && stableRounds < 2; round += 1) {
      if (stopRequested) break;
      const snapshot = collectOrders(options, true);
      rows.push(...snapshot.rows);
      orderKeys.push(...snapshot.orderKeys);
      receiptDates.push(...snapshot.receiptDates);

      const visibleReceiptDates = snapshot.receiptDates.filter(Boolean);
      const screenIsOlderThanRange = Boolean(options.dateFrom) && visibleReceiptDates.length > 0 &&
        visibleReceiptDates.every((date) => date < options.dateFrom);
      olderReceiptRounds = screenIsOlderThanRange ? olderReceiptRounds + 1 : 0;
      if (olderReceiptRounds >= 2) {
        stoppedByReceiptDate = true;
        addDiagnostic('info', 'Прокрутка остановлена по датам получения', {
          dateFrom: options.dateFrom,
          visibleReceiptDates
        });
        updateOverlay(`Загрузка истории завершена: даты получения уже раньше ${options.dateFrom}. Не закрывайте эту вкладку.`);
        break;
      }

      if (round === maxScrolls) {
        scrollLimitReached = true;
        break;
      }

      clickLoadMore();
      const scrolling = document.scrollingElement || document.documentElement;
      const viewportHeight = Math.max(window.innerHeight || 0, 600);
      window.scrollTo({
        top: scrolling.scrollTop + Math.floor(viewportHeight * 0.82),
        behavior: 'auto'
      });
      updateOverlay(`Загружаю историю заказов… прокрутка ${round + 1} из ${maxScrolls}`);
      await wait(850);

      if (stopRequested) break;

      if (hasReachedRecommendations()) break;

      const currentTop = scrolling.scrollTop;
      if (currentTop === previousTop) stableRounds += 1;
      else stableRounds = 0;
      previousTop = currentTop;
    }

    const uniqueRows = uniqueBy(rows, (row) => JSON.stringify(row));
    const dates = uniqueRows.map((row) => row['Дата заказа']).filter(Boolean).sort();
    const sortedReceiptDates = receiptDates.filter(Boolean).sort();
    return {
      rows: uniqueRows,
      orderKeys: [...new Set(orderKeys)],
      earliestDate: dates[0] || '',
      earliestReceiptDate: sortedReceiptDates[0] || '',
      scrollLimitReached,
      stoppedByReceiptDate
    };
  }

  function hasReachedRecommendations() {
    return [...document.querySelectorAll('h1,h2,h3')]
      .some((node) => /подобрали\s+по\s+вашим\s+интересам/i.test(clean(node.textContent)));
  }

  function clickLoadMore() {
    const buttons = [...document.querySelectorAll('button')];
    const button = buttons.find((item) => /показать ещё|загрузить ещё|показать больше/i.test(clean(item.textContent)));
    if (button && !button.disabled) button.click();
  }

  function collectOrders(options, viewportOnly = false) {
    const anchors = findOrderAnchors().filter((anchor) => !viewportOnly || isNearViewport(anchor));
    const cards = unique(anchors.map(findOrderCard).filter(Boolean));
    const rows = [];
    const orderIds = new Set();
    const receiptDates = [];

    for (const card of cards) {
      const rawText = card.innerText || '';
      const text = clean(rawText);
      const orderAnchor = [...card.querySelectorAll('a[href]')].find(isOrderLink);
      const orderUrl = orderAnchor ? absoluteUrl(orderAnchor.href) : '';
      const orderNumber = extractOrderNumber(text, orderUrl);
      const orderDate = extractOrderDate(text);
      const receiptDate = extractReceiptDate(rawText);
      const status = extractStatus(rawText);
      if (receiptDate) receiptDates.push(receiptDate);

      if (!passesFilters(orderDate, status, options)) continue;

      const productAnchors = uniqueBy(
        [...card.querySelectorAll('a[href*="/product/"]')].filter((a) => clean(a.textContent)),
        (a) => `${absoluteUrl(a.href)}|${clean(a.textContent)}`
      );
      const fallbackProducts = extractProductsByPrice(card);
      const total = extractMoneyAfterLabel(text, ['Итого', 'Сумма заказа', 'Оплачено']);

      if (!productAnchors.length && fallbackProducts.length) {
        for (const product of fallbackProducts) {
          rows.push(buildRow({ orderNumber, orderDate, status: product.status || status, orderUrl, total, ...product }));
        }
      } else if (!productAnchors.length) {
        rows.push(buildRow({ orderNumber, orderDate, status, orderUrl, total }));
      } else {
        for (const productAnchor of productAnchors) {
          const productBox = findProductBox(productAnchor, card);
          const productText = clean(productBox?.innerText || productAnchor.textContent);
          rows.push(buildRow({
            orderNumber,
            orderDate,
            status,
            orderUrl,
            total,
            product: clean(productAnchor.textContent),
            productUrl: absoluteUrl(productAnchor.href),
            quantity: extractQuantity(productText),
            price: extractBestPrice(productText)
          }));
        }
      }
      orderIds.add(orderNumber || orderUrl || text.slice(0, 80));
    }

    return {
      rows: uniqueBy(rows, (row) => JSON.stringify(row)),
      orderKeys: [...orderIds],
      receiptDates
    };
  }

  function isNearViewport(node) {
    const rect = node.getBoundingClientRect();
    const margin = 220;
    return (rect.width > 0 || rect.height > 0) &&
      rect.bottom >= -margin &&
      rect.top <= Math.max(window.innerHeight || 0, 600) + margin;
  }

  function findOrderAnchors() {
    return [...document.querySelectorAll('a[href]')].filter(isOrderLink);
  }

  function isOrderLink(anchor) {
    const href = anchor.getAttribute('href') || '';
    return /\/my\/order(?:details|list\/)?/i.test(href) && !/\/my\/orderlist\/?$/i.test(href);
  }

  function findOrderCard(anchor) {
    let node = anchor;
    let best = null;
    for (let depth = 0; node && depth < 9; depth += 1, node = node.parentElement) {
      const text = clean(node.innerText);
      if (text.length > 40 && text.length < 9000) best = node;
      const productCount = node.querySelectorAll?.('a[href*="/product/"]').length || 0;
      const orderCount = [...(node.querySelectorAll?.('a[href]') || [])].filter(isOrderLink).length;
      if (productCount && orderCount === 1 && text.length < 7000) return node;
      if (orderCount > 1) break;
    }
    return best;
  }

  function findProductBox(anchor, card) {
    let node = anchor;
    let firstPriceBox = null;
    for (let depth = 0; node && node !== card && depth < 5; depth += 1, node = node.parentElement) {
      const text = clean(node.innerText || node.textContent);
      if (/₽|руб\.?/i.test(text) && text.length < 1800) {
        if (!firstPriceBox) firstPriceBox = node;
        if (/\d+\s*[×xх]\s*\d[\d\s.,]*\s*(?:₽|руб\.?)/i.test(text)) return node;
      }
    }
    return firstPriceBox || anchor.parentElement;
  }

  function findPricingContext(start, root) {
    let node = start;
    let fallback = start;
    for (let depth = 0; node && node !== root && depth < 4; depth += 1, node = node.parentElement) {
      const text = clean(node.innerText || node.textContent);
      if (text.length > 2500) break;
      const moneyValues = text.match(/\d[\d\s.,]*\s*(?:₽|руб\.?)/gi) || [];
      if (moneyValues.length > 2) break;
      if (/₽|руб\.?/i.test(text)) fallback = node;
      const multiplied = text.match(/\d+\s*[×xх]\s*\d[\d\s.,]*\s*(?:₽|руб\.?)/gi) || [];
      if (multiplied.length === 1) return node;
    }
    return fallback;
  }

  function mergeProducts(products) {
    const merged = new Map();
    for (const product of products || []) {
      const key = OzonReturnTools.normalizeName(product.product) || product.productUrl;
      if (!key) continue;
      const current = merged.get(key);
      const score = (Number.parseInt(product.quantity, 10) > 1 ? 5 : 0) +
        (product.productUrl ? 2 : 0) + (product.status ? 1 : 0) + (product.price ? 1 : 0);
      const currentScore = current
        ? (Number.parseInt(current.quantity, 10) > 1 ? 5 : 0) +
          (current.productUrl ? 2 : 0) + (current.status ? 1 : 0) + (current.price ? 1 : 0)
        : -1;
      if (!current) {
        merged.set(key, product);
      } else {
        const preferred = score > currentScore ? product : current;
        const other = preferred === product ? current : product;
        const maximumQuantity = Math.max(
          Number.parseInt(current.quantity, 10) || 1,
          Number.parseInt(product.quantity, 10) || 1
        );
        merged.set(key, {
          ...other,
          ...preferred,
          productUrl: preferred.productUrl || other.productUrl || '',
          status: preferred.status || other.status || '',
          price: preferred.price || other.price || '',
          quantity: String(maximumQuantity)
        });
      }
    }
    return [...merged.values()];
  }

  function extractOrderNumber(text, url) {
    const fromText = text.match(/(?:заказ|номер заказа)\s*(?:№|#)?\s*([\d-]{4,})/i);
    if (fromText) return fromText[1];
    try {
      const parsed = new URL(url);
      return parsed.searchParams.get('order') || parsed.searchParams.get('orderId') ||
        parsed.pathname.match(/orderdetails\/(\d+)/i)?.[1] || '';
    } catch {
      return '';
    }
  }

  function extractDate(text) {
    const numeric = text.match(/\b([0-3]?\d[./-][01]?\d[./-](?:20)?\d{2})\b/);
    if (numeric) return normalizeDate(numeric[1]);

    const months = 'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря';
    const named = text.match(new RegExp(`\\b([0-3]?\\d)\\s+(${months})(?:\\s+(20\\d{2}))?`, 'i'));
    if (!named) return '';
    const monthIndex = months.split('|').findIndex((month) => month === named[2].toLowerCase()) + 1;
    let year = named[3] ? Number(named[3]) : new Date().getFullYear();
    const candidate = new Date(year, monthIndex - 1, Number(named[1]));
    if (!named[3] && candidate.getTime() > Date.now() + 31 * 86400000) year -= 1;
    return `${year}-${String(monthIndex).padStart(2, '0')}-${String(named[1]).padStart(2, '0')}`;
  }

  function extractOrderDate(text) {
    const value = String(text || '');
    const months = 'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря';
    const labeled = value.match(new RegExp(
      `(?:заказ(?:\\s+оформлен)?\\s+от|дата\\s+заказа)\\s*[:—-]?\\s*([0-3]?\\d(?:[./-][01]?\\d[./-](?:20)?\\d{2}|\\s+(?:${months})(?:\\s+20\\d{2})?))`,
      'i'
    ));
    return labeled ? extractDate(labeled[1]) : '';
  }

  function extractReceiptDate(text) {
    const value = String(text || '');
    const months = 'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря';
    const labeled = value.match(new RegExp(
      `(?:получен(?:о)?|доставлен(?:о)?|выдан(?:о)?|оставили\\s+у\\s+двери)\\s*[:—-]?\\s*([0-3]?\\d(?:[./-][01]?\\d[./-](?:20)?\\d{2}|\\s+(?:${months})(?:\\s+20\\d{2})?))`,
      'i'
    ));
    return labeled ? extractDate(labeled[1]) : '';
  }

  function normalizeDate(value) {
    const parts = value.split(/[./-]/).map(Number);
    if (parts[0] > 31) return `${parts[0]}-${String(parts[1]).padStart(2, '0')}-${String(parts[2]).padStart(2, '0')}`;
    const year = parts[2] < 100 ? 2000 + parts[2] : parts[2];
    return `${year}-${String(parts[1]).padStart(2, '0')}-${String(parts[0]).padStart(2, '0')}`;
  }

  function extractStatus(text) {
    const lines = String(text).split(/\n+/).map(clean).filter((line) => line.length && line.length < 120);
    const statusPattern = /^(?:заказ\s+)?(?:получен|доставлен|оставили\s+у\s+двери|отмен[её]н|возврат\s+(?:оформлен|заверш[её]н|принят|одобрен)|(?:товар|деньги)\s+возвращ[её]н|не\s+выкуплен|в пути|ожидает|доставим|готов к выдаче)/i;
    const candidates = lines.filter((line) => statusPattern.test(line));
    candidates.sort((a, b) => a.length - b.length);
    return candidates[0] || '';
  }

  function extractQuantity(text) {
    const source = String(text || '').replace(/\u00a0|\u202f/g, ' ');
    const labeled = source.match(/количество\s*[:—-]?\s*(\d+)/i);
    if (labeled) return labeled[1];
    const multiplied = source.match(/(?:^|[^\d])(\d{1,3})\s*[×xх*]\s*\d[\d\s.,]*\s*(?:₽|руб\.?)/i);
    if (multiplied) return multiplied[1];
    const priceFirst = source.match(/(?:^|\s)\d[\d\s.,]*\s*(?:₽|руб\.?)\s*[×xх*]\s*(\d{1,3})/i);
    if (priceFirst) return priceFirst[1];

    // Ozon иногда визуально разрывает «2 × 55,10 ₽» на разные DOM-узлы.
    // В этом случае количество восстанавливается из суммы строки и цены единицы.
    const moneyValues = [...source.matchAll(/(?:^|\s)(\d[\d\s]*[.,]?\d{0,2})\s*(?:₽|руб\.?)/gi)]
      .map((match) => Number(normalizeMoney(match[1])))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (moneyValues.length === 2 && moneyValues[0] > moneyValues[1]) {
      const ratio = moneyValues[0] / moneyValues[1];
      const rounded = Math.round(ratio);
      if (rounded >= 2 && rounded <= 100 && Math.abs(ratio - rounded) < 0.01) return String(rounded);
    }
    return '1';
  }

  function extractBestPrice(text) {
    const multiplied = String(text).match(/(?:^|\s)\d+\s*[×xх]\s*(\d[\d\s]*[.,]?\d{0,2})\s*(?:₽|руб\.?)/i);
    if (multiplied) return normalizeMoney(multiplied[1]);
    const values = [...text.matchAll(/(?:^|\s)(\d[\d\s]*[.,]?\d{0,2})\s*(?:₽|руб\.?)/gi)]
      .map((match) => normalizeMoney(match[1]));
    return values[0] || '';
  }

  function extractMoneyAfterLabel(text, labels) {
    for (const label of labels) {
      const match = text.match(new RegExp(`${label}[^\\d]{0,30}(\\d[\\d\\s]*[.,]?\\d{0,2})\\s*(?:₽|руб\\.?)`, 'i'));
      if (match) return normalizeMoney(match[1]);
    }
    return '';
  }

  function normalizeMoney(value) {
    return value.replace(/\s/g, '').replace(',', '.');
  }

  function passesFilters(date, status, options, requireDate = false) {
    const statusText = status.toLowerCase();
    if (/отмен[её]н|возврат\s+(?:оформлен|заверш[её]н|принят|одобрен)|возвращ[её]н|не\s+выкуплен/.test(statusText)) return false;
    if (requireDate && (options.dateFrom || options.dateTo) && !date) return false;
    if (options.dateFrom && date && date < options.dateFrom) return false;
    if (options.dateTo && date && date > options.dateTo) return false;
    return true;
  }

  function buildRow(data) {
    const [year = '', month = ''] = String(data.orderDate || '').split('-');
    return {
      'Дата заказа': data.orderDate || '',
      'Год': year,
      'Месяц': month,
      'Номер заказа': data.orderNumber || '',
      'Статус': data.status || '',
      'Статус возврата': data.returnStatus || '',
      'Товар': data.product || '',
      'Количество': data.quantity || '',
      'Цена товара': data.price || '',
      'Реальная цена': data.realPrice || data.price || '',
      'Сумма заказа': data.total || '',
      'Ссылка на товар': data.productUrl || '',
      'Ссылка на заказ': data.orderUrl || ''
    };
  }

  function makeCsv(rows, options = {}, summary = {}) {
    const columns = CSV_COLUMNS;
    const parameterLines = [
      ['Параметры выгрузки', ''],
      ['Версия приложения', chrome.runtime.getManifest().version],
      ['Сформировано', new Date().toLocaleString('ru-RU')],
      ['Дата от', options.dateFrom || 'не указана'],
      ['Дата до', options.dateTo || 'не указана'],
      ['Автозагрузка истории', options.autoScroll ? 'Да' : 'Нет'],
      ['Максимум прокруток списка', options.maxScrolls || ''],
      ['Режим вкладок', options.showTabs ? 'Активные, по одной' : 'Неактивные, до двух'],
      ['Использовать кэш', options.useCache === false ? 'Нет — перечитать и обновить' : 'Да'],
      ['Включать товары с возвратом', options.includeReturned ? 'Да' : 'Нет'],
      ['Заказов в результате', summary.orders ?? ''],
      ['Строк товаров', summary.rows ?? rows.length],
      ['Возвращено товаров — кол-во', summary.returnedQuantity ?? ''],
      ['Исключено возвратов', summary.excludedReturns ?? ''],
      ['Заказов взято из кэша', summary.cacheHits ?? ''],
      ['Закрытых заказов сохранено в кэш', summary.cacheWrites ?? ''],
      ['Завершение списка', summary.stopReason || ''],
      []
    ];
    const lines = [
      ...parameterLines,
      columns,
      ...rows.map((row) => columns.map((column) => formatCsvValue(column, row[column])))
    ];
    return '\uFEFF' + lines.map((line) => line.map(csvCell).join(';')).join('\r\n');
  }

  function formatCsvValue(column, value) {
    if (!['Цена товара', 'Реальная цена', 'Сумма заказа'].includes(column)) return value ?? '';
    return String(value ?? '').replace('.', ',');
  }

  function filenameDate(value, fallback) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : fallback;
  }

  function buildExportFilename(options = {}, partial = false) {
    const today = new Date().toISOString().slice(0, 10);
    const from = filenameDate(options.dateFrom, 'начало');
    const to = filenameDate(options.dateTo, today);
    const now = new Date();
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((value) => String(value).padStart(2, '0')).join('-');
    const version = chrome.runtime.getManifest().version;
    return `ozon_orders${partial ? '_partial' : ''}_${from}_${to}_${time} (v${version}).csv`;
  }

  function csvCell(value) {
    const string = String(value ?? '');
    return `"${string.replace(/"/g, '""')}"`;
  }

  function downloadCsv(csv, filename = `ozon_orders_${new Date().toISOString().slice(0, 10)}.csv`) {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, filename);
  }

  function downloadJson(value, filename) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' });
    downloadBlob(blob, filename);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function startDiagnostics(options) {
    diagnostics = {
      reportFormat: 1,
      extensionVersion: chrome.runtime.getManifest().version,
      startedAt: new Date().toISOString(),
      pageUrl: location.href,
      options: {
        dateFrom: options.dateFrom || '',
        dateTo: options.dateTo || '',
        autoScroll: Boolean(options.autoScroll),
        maxScrolls: options.maxScrolls || '',
        showTabs: Boolean(options.showTabs),
        useCache: options.useCache !== false,
        includeReturned: Boolean(options.includeReturned)
      },
      orders: [],
      events: []
    };
  }

  function addDiagnostic(level, message, data = {}) {
    if (!diagnostics) return;
    diagnostics.events.push({
      time: new Date().toISOString(),
      level,
      message,
      ...data
    });
    if (diagnostics.events.length > 500) diagnostics.events.shift();
  }

  function addReturnDiagnostic(base, detail, options = {}) {
    if (!diagnostics) return;
    const checked = OzonReturnTools.filterReturnedProducts(detail.products || [], detail.returnCheck, {
      includeReturned: Boolean(options.includeReturned)
    });
    diagnostics.orders.push({
      orderNumber: base['Номер заказа'] || '',
      orderUrl: base['Ссылка на заказ'] || '',
      ...checked.report
    });
    if (diagnostics.orders.length > 500) diagnostics.orders.shift();
    if (checked.report.returnCheck === 'error') {
      addDiagnostic('warning', 'Проверка возвратов завершилась с ошибкой', {
        orderNumber: base['Номер заказа'] || '',
        orderUrl: base['Ссылка на заказ'] || '',
        error: checked.report.error || checked.report.loadResult || 'Неизвестная ошибка'
      });
    }
  }

  function buildDiagnosticReport(rows, stage, decision) {
    const orderNumbers = new Set(rows.map((row) => row['Номер заказа']).filter(Boolean));
    return {
      ...diagnostics,
      stoppedAt: new Date().toISOString(),
      stoppedStage: stage,
      userDecision: decision,
      partialResult: {
        rows: rows.length,
        orders: orderNumbers.size,
        rowsWithProduct: rows.filter((row) => row['Товар']).length,
        rowsWithoutProduct: rows.filter((row) => !row['Товар']).length
      }
    };
  }

  function offerStoppedExport(rows, stage, summary = {}) {
    addDiagnostic('info', 'Выгрузка остановлена пользователем', { stage, partialRows: rows.length });
    return new Promise((resolve) => {
      const overlay = document.getElementById(OVERLAY_ID) || createOverlay();
      const status = overlay.querySelector('[data-status]');
      const stop = overlay.querySelector('[data-stop]');
      const actions = overlay.querySelector('[data-partial-actions]');
      status.textContent = `Остановлено. Получено строк: ${rows.length}. Скачать частичный CSV и отчёт?`;
      lastMessage = status.textContent;
      stop.style.display = 'none';
      actions.hidden = false;

      const finish = (download) => {
        const day = new Date().toISOString().slice(0, 10);
        const decision = download ? 'download' : 'discard';
        addDiagnostic('info', download ? 'Пользователь выбрал скачивание' : 'Пользователь отказался от скачивания');
        if (download) {
          const partialOrders = new Set(rows.map((row) => row['Номер заказа']).filter(Boolean)).size;
          const partialReturnedQuantity = rows
            .filter((row) => /заявка\s+на\s+возврат|частичный\s+возврат/i.test(row['Статус возврата'] || ''))
            .reduce((sum, row) => sum + (Number.parseInt(row['Количество'], 10) || 1), 0);
          downloadCsv(makeCsv(rows, diagnostics?.options || {}, {
            orders: partialOrders,
            rows: rows.length,
            returnedQuantity: summary.returnedQuantity ?? partialReturnedQuantity,
            excludedReturns: summary.excludedReturns ?? '',
            cacheHits: summary.cacheHits ?? '',
            cacheWrites: summary.cacheWrites ?? '',
            stopReason: `Остановлено пользователем: ${stage}`
          }), buildExportFilename(diagnostics?.options || {}, true));
          const from = filenameDate(diagnostics?.options?.dateFrom, 'начало');
          const to = filenameDate(diagnostics?.options?.dateTo, day);
          downloadJson(buildDiagnosticReport(rows, stage, decision), `ozon_export_report_${from}_${to}.json`);
        }
        actions.hidden = true;
        stop.style.display = '';
        updateOverlay(download
          ? `Выгрузка остановлена. Скачаны частичный CSV (${rows.length} строк) и отчёт.`
          : 'Выгрузка остановлена. Файлы не созданы.');
        resolve();
      };

      actions.querySelector('[data-download-partial]').onclick = () => finish(true);
      actions.querySelector('[data-discard-partial]').onclick = () => finish(false);
    });
  }

  function createOverlay() {
    document.getElementById(OVERLAY_ID)?.remove();
    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = [
      'position:fixed', 'right:20px', 'bottom:20px', 'z-index:2147483647',
      'max-width:380px', 'padding:14px 42px 14px 16px', 'border-radius:12px',
      'background:#111827', 'color:#fff', 'box-shadow:0 8px 30px #0005',
      'font:14px/1.4 Arial,sans-serif'
    ].join(';');
    overlay.innerHTML = [
      '<span data-status>Подготовка…</span>',
      '<div data-keep-tab>Не закрывайте эту вкладку с заказами до завершения выгрузки.</div>',
      '<button data-stop type="button">Стоп</button>',
      '<div data-partial-actions hidden>',
      '<button data-download-partial type="button">Скачать CSV и отчёт</button>',
      '<button data-discard-partial type="button">Не скачивать</button>',
      '</div>',
      '<button data-close type="button" aria-label="Закрыть">×</button>'
    ].join('');
    const stop = overlay.querySelector('[data-stop]');
    const keepTab = overlay.querySelector('[data-keep-tab]');
    keepTab.style.cssText = 'margin-top:7px;color:#fde68a;font-size:12px;font-weight:700';
    stop.style.cssText = 'margin-left:12px;padding:5px 9px;border:0;border-radius:7px;background:#dc2626;color:#fff;font-weight:700;cursor:pointer';
    stop.addEventListener('click', () => {
      if (stop.dataset.mode === 'exit') {
        overlay.remove();
        return;
      }
      stopRequested = true;
      activeControllers.forEach((controller) => controller.abort());
      chrome.runtime.sendMessage({ type: 'OZON_ABORT_DETAIL_TABS' }).catch(() => {});
      updateOverlay('Останавливаю выгрузку…');
      stop.disabled = true;
    });
    const partialActions = overlay.querySelector('[data-partial-actions]');
    partialActions.style.cssText = 'margin-top:10px;display:flex;gap:8px;flex-wrap:wrap';
    const downloadPartial = overlay.querySelector('[data-download-partial]');
    downloadPartial.style.cssText = 'padding:7px 10px;border:0;border-radius:7px;background:#16a34a;color:#fff;font-weight:700;cursor:pointer';
    const discardPartial = overlay.querySelector('[data-discard-partial]');
    discardPartial.style.cssText = 'padding:7px 10px;border:1px solid #6b7280;border-radius:7px;background:#374151;color:#fff;font-weight:700;cursor:pointer';
    const close = overlay.querySelector('[data-close]');
    close.style.cssText = 'position:absolute;right:10px;top:7px;border:0;background:transparent;color:#fff;font-size:22px;cursor:pointer';
    close.addEventListener('click', () => {
      if (!partialActions.hidden) discardPartial.click();
      overlay.remove();
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  function updateOverlay(text, error = false) {
    lastMessage = text;
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;
    overlay.style.background = error ? '#991b1b' : '#111827';
    overlay.querySelector('[data-status]').textContent = text;
    const stop = overlay.querySelector('[data-stop]');
    const finished = /^(?:Готово:|Ошибка:|Выгрузка остановлена|Заказы не найдены|По выбранному периоду|Откройте раздел)/i.test(text);
    stop.textContent = finished ? 'Выйти' : 'Стоп';
    stop.dataset.mode = finished ? 'exit' : 'stop';
    stop.disabled = false;
  }

  function absoluteUrl(href) {
    try { return new URL(href, location.origin).href; } catch { return href || ''; }
  }

  function clean(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function unique(items) {
    return [...new Set(items)];
  }

  function uniqueBy(items, key) {
    const seen = new Set();
    return items.filter((item) => {
      const value = key(item);
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
