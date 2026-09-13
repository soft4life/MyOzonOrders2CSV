(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OzonReturnTools = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function clean(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeName(value) {
    return clean(value).toLowerCase().replace(/ё/g, 'е')
      .replace(/[^a-zа-я0-9]+/gi, ' ').replace(/\s+/g, ' ').trim();
  }

  function normalizePrice(value) {
    const match = String(value || '').replace(/\s/g, '').replace(',', '.').match(/\d+(?:\.\d{1,2})?/);
    return match ? Number(match[0]).toFixed(2) : '';
  }

  function numberMoney(value) {
    const normalized = String(value ?? '').replace(/\s/g, '').replace(',', '.');
    const number = Number(normalized);
    return Number.isFinite(number) ? number : 0;
  }

  function moneyValue(value) {
    return Number(value).toFixed(2);
  }

  function addRealPrices(products, detail = {}) {
    const prepared = (products || []).map((product) => {
      const quantity = Math.max(1, Number.parseInt(product.quantity, 10) || 1);
      const unitPrice = numberMoney(product.price);
      return { ...product, quantity: String(quantity), unitPrice, linePrice: unitPrice * quantity };
    });
    const displayedTotal = prepared.reduce((sum, product) => sum + product.linePrice, 0);
    const goodsTotal = numberMoney(detail.goodsTotal);
    const deliveryTotal = numberMoney(detail.deliveryTotal);
    const bonusPayment = numberMoney(detail.bonusPayment);
    const paidTotal = numberMoney(detail.total);
    const targetTotal = goodsTotal > 0
      ? goodsTotal + deliveryTotal
      : (paidTotal > 0 ? paidTotal + bonusPayment : displayedTotal + deliveryTotal);
    const needsRedistribution = bonusPayment > 0 || deliveryTotal > 0;
    const factor = needsRedistribution && displayedTotal > 0 && targetTotal > 0
      ? targetTotal / displayedTotal
      : 1;

    return prepared.map(({ unitPrice, linePrice, ...product }) => ({
      ...product,
      realPrice: moneyValue(unitPrice * factor)
    }));
  }

  function calculateOrderTotal(detail = {}, fallback = '') {
    const goodsTotal = numberMoney(detail.goodsTotal);
    const deliveryTotal = numberMoney(detail.deliveryTotal);
    if (goodsTotal > 0) return moneyValue(goodsTotal + deliveryTotal);
    const fallbackTotal = numberMoney(fallback || detail.total);
    return fallbackTotal > 0 ? moneyValue(fallbackTotal) : '';
  }

  function productId(value) {
    const raw = clean(value);
    if (!raw) return '';
    const fromProductUrl = raw.match(/\/product\/(?:[^/?#]*-)?(\d{5,})(?:[/?#]|$)/i);
    if (fromProductUrl) return fromProductUrl[1];
    const fromField = raw.match(/^\d{5,}$/);
    return fromField ? fromField[0] : '';
  }

  function sameOrContainedName(left, right) {
    if (!left || !right) return false;
    if (left === right) return true;
    const shorter = left.length <= right.length ? left : right;
    const longer = left.length > right.length ? left : right;
    return shorter.length >= 14 && longer.includes(shorter);
  }

  function tokenSimilarity(left, right) {
    const leftTokens = new Set(left.split(' ').filter((token) => token.length > 2));
    const rightTokens = new Set(right.split(' ').filter((token) => token.length > 2));
    if (!leftTokens.size || !rightTokens.size) return 0;
    let shared = 0;
    leftTokens.forEach((token) => { if (rightTokens.has(token)) shared += 1; });
    return shared / Math.min(leftTokens.size, rightTokens.size);
  }

  function chooseMatch(returnItem, products, used) {
    const rid = productId(returnItem.productId || returnItem.productUrl);
    const rname = normalizeName(returnItem.product);
    const rprice = normalizePrice(returnItem.price);
    const candidates = products.map((product, index) => ({
      product, index,
      id: productId(product.productId || product.productUrl),
      name: normalizeName(product.product),
      price: normalizePrice(product.price)
    })).filter((candidate) => !used.has(candidate.index));

    const byId = rid ? candidates.filter((candidate) => candidate.id && candidate.id === rid) : [];
    if (byId.length === 1) return { index: byId[0].index, method: 'product_id' };
    const byNamePrice = candidates.filter((candidate) =>
      rprice && candidate.price === rprice &&
      (sameOrContainedName(rname, candidate.name) || tokenSimilarity(rname, candidate.name) >= 0.65));
    if (byNamePrice.length === 1) return { index: byNamePrice[0].index, method: 'name_price' };
    const byPrice = rprice ? candidates.filter((candidate) => candidate.price === rprice) : [];
    if (byPrice.length === 1) return { index: byPrice[0].index, method: 'unique_price' };
    const byName = candidates.filter((candidate) => sameOrContainedName(rname, candidate.name));
    if (byName.length === 1) return { index: byName[0].index, method: 'unique_name' };
    return null;
  }

  function filterReturnedProducts(orderProducts, returnCheck, options = {}) {
    const products = (orderProducts || []).map((product) => ({ ...product }));
    const items = returnCheck?.items || [];
    const used = new Set();
    const excluded = new Set();
    const replacements = new Map();
    const reportItems = [];
    const requestedItems = items.filter((item) => item.returnState === 'return_requested');
    const returnedQuantityTotal = requestedItems.reduce((sum, item) => {
      const quantity = Number.parseInt(item.returnedQuantity || item.quantity, 10);
      return sum + (Number.isFinite(quantity) && quantity > 0 ? quantity : 1);
    }, 0);

    const fallbackStatus = returnCheck?.returnCheck === 'completed'
      ? 'Возврат для товара недоступен'
      : returnCheck?.returnCheck === 'unavailable'
        ? 'Кнопка возврата недоступна'
        : returnCheck?.returnCheck === 'error'
          ? 'Ошибка проверки возврата'
          : returnCheck?.returnCheck === 'skipped_outside_period'
            ? 'Вне выбранного периода'
            : 'Не проверено';
    products.forEach((product) => { product.returnStatus = fallbackStatus; });

    items.forEach((item, itemIndex) => {
      let match = chooseMatch(item, products, used);
      if (!match && items.length === products.length && items.every((entry) => entry.returnState === 'return_requested')) {
        match = { index: itemIndex, method: 'position_all_requested' };
      }
      if (!match) {
        reportItems.push({
          product: item.product || '',
          returnState: item.returnState === 'return_requested' ? 'unknown' : (item.returnState || 'unknown'),
          matchMethod: '', action: 'kept_unmatched'
        });
        return;
      }
      used.add(match.index);
      if (item.returnState !== 'return_requested') {
        const returnStatus = item.returnState === 'return_expired'
          ? 'Срок возврата истёк'
          : item.returnState === 'return_unavailable'
            ? 'Товар нельзя вернуть'
            : 'Заявки на возврат нет';
        replacements.set(match.index, { ...products[match.index], returnStatus });
        reportItems.push({ product: products[match.index].product || item.product || '', returnState: item.returnState || 'return_available', matchMethod: match.method, action: 'kept' });
        return;
      }
      const orderQuantity = Math.max(1, Number.parseInt(products[match.index].quantity, 10) || 1);
      const returnedQuantity = Number.parseInt(item.returnedQuantity, 10);
      if (options.includeReturned) {
        const returnStatus = Number.isFinite(returnedQuantity) && returnedQuantity > 0 && returnedQuantity < orderQuantity
          ? 'Частичный возврат'
          : 'Есть заявка на возврат';
        replacements.set(match.index, { ...products[match.index], returnStatus });
        reportItems.push({ product: products[match.index].product || item.product || '', returnState: 'return_requested', matchMethod: match.method, action: 'included' });
        return;
      }
      if (Number.isFinite(returnedQuantity) && returnedQuantity > 0 && returnedQuantity < orderQuantity) {
        replacements.set(match.index, { ...products[match.index], quantity: String(orderQuantity - returnedQuantity), returnStatus: 'Частичный возврат' });
        reportItems.push({ product: products[match.index].product || item.product || '', returnState: 'return_requested', matchMethod: match.method, action: 'quantity_reduced', returnedQuantity, remainingQuantity: orderQuantity - returnedQuantity });
      } else {
        excluded.add(match.index);
        reportItems.push({ product: products[match.index].product || item.product || '', returnState: 'return_requested', matchMethod: match.method, action: 'excluded' });
      }
    });

    if (reportItems.some((item) => item.returnState === 'unknown')) {
      products.forEach((product, index) => {
        if (!used.has(index) && !excluded.has(index)) {
          const current = replacements.get(index) || product;
          replacements.set(index, { ...current, returnStatus: 'Найдена заявка — сопоставление не удалось' });
        }
      });
    }

    return {
      products: products.map((product, index) => replacements.get(index) || product)
        .filter((_product, index) => !excluded.has(index)),
      report: {
        ...returnCheck,
        orderProducts: products.length,
        returnPageProducts: items.length,
        matchedProducts: used.size,
        returnedProducts: requestedItems.length,
        returnedQuantity: returnedQuantityTotal,
        excludedProducts: excluded.size,
        reducedProducts: replacements.size,
        unknownProducts: reportItems.filter((item) => item.returnState === 'unknown').length,
        items: reportItems
      }
    };
  }

  return { clean, normalizeName, normalizePrice, productId, addRealPrices, calculateOrderTotal, filterReturnedProducts };
});
