const CONFIG = {
  BUSINESS_COUNT: 120,
  MAX_ORDERS_PER_BUSINESS: 1000,
  ORDER_VALUE: 4.275,
  UNIT_VALUE: 4.275,
  ORDERS_PER_UNIT: 120,
  INDEX_TICKER: 'LAVNDR120',
  MAX_COMPONENT_WEIGHT: 0.20,
  SETTLEMENT_DAYS: 2,
  API_KEY: 'LAVNDR_SECRET_KEY_2026',
  MASTER_SHEET_ID: '13xLguUdKEq1T14amD9naegXPL-OhggJWlLauV4NKLn8',
  TIMEZONE: 'Africa/Khartoum',
  MAX_TABLE_ROWS: 120,
  CACHE_TTL: 300000,
  SHEET_TIMEOUT_MS: 2000,
  SNAPSHOT_DAY: 21,
  SHARE_PRICE: 513,
  RENDER_URL: 'https://lavndr120.onrender.com',  // رابط Flask على Render
  RENDER_SECRET: 'LAVNDR_RENDER_SECRET_2026'  // مفتاح سري مشترك بين GAS و Render
};

const BUSINESS_SHEETS = ['ID-1', 'ID-2'];
const ALLOWED_EMAILS = ['imspractice69@gmail.com'];
const AUTHORIZED_PARTICIPANTS = {'AP001': 'شركة السودان للوساطة'};

const props = PropertiesService.getScriptProperties();
const cache = CacheService.getScriptCache();

// ─────────────────────────────────────────────
// التهيئة
// ─────────────────────────────────────────────
function initializeSystem() {
  const master = SpreadsheetApp.openById(CONFIG.MASTER_SHEET_ID);
  if (!master.getSheetByName('History')) {
    master.insertSheet('History').appendRow(['Timestamp','NAV','IIV','Premium%','NetOrders','NetUnits','GrossOrders','Redemptions']);
  }
  if (!master.getSheetByName('AP_Orders')) {
    master.insertSheet('AP_Orders').appendRow(['Timestamp','AP_Code','Type','Units','CashInLieu','SettlementDate','Status']);
  }
  if (!master.getSheetByName('Monthly_Snapshots')) {
    master.insertSheet('Monthly_Snapshots').appendRow(['Month','Date','NAV','IIV','Premium%','NetOrders','NetUnits','Components','Top5']);
  }
  // ✅ جديد: شيت المشاركين
  if (!master.getSheetByName('Participants')) {
    master.insertSheet('Participants').appendRow(['Email','Status','EntryNAV','EntryDate','SharePrice','CurrentValue','PnL','Allocation']);
  }
  // ✅ جديد: شيت السوق الداخلي
  if (!master.getSheetByName('Market')) {
    master.insertSheet('Market').appendRow(['SellerEmail','ShareValue','ListDate','Status','BuyerEmail','CloseDate']);
  }
  BUSINESS_SHEETS.forEach(id => {
    try {
      const ss = SpreadsheetApp.openById(id);
      if (!ss.getSheetByName('Orders')) {
        ss.insertSheet('Orders').appendRow(['Timestamp','Product','Qty','Price','Total','Customer','Type','AP_Code']);
      }
    } catch(e) {}
  });
  props.setProperty('INITIALIZED', 'TRUE');
  return 'System Initialized';
}

function createHourlyTrigger() {
  ScriptApp.newTrigger('updateHistory').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('checkMonthlySnapshot').timeBased().everyDays(1).atHour(0).create();
  return 'Triggers Created';
}

// ─────────────────────────────────────────────
// Snapshots & History
// ─────────────────────────────────────────────
function checkMonthlySnapshot() {
  const now = new Date();
  const day = parseInt(Utilities.formatDate(now, CONFIG.TIMEZONE, 'dd'));
  if (day === CONFIG.SNAPSHOT_DAY) saveMonthlySnapshotWithNotification();
}

function saveMonthlySnapshot() {
  const data = getData();
  const month = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM');
  const top5 = data.trending.slice(0,5).map(x => x[0]).join(', ');
  const snapshotSheet = SpreadsheetApp.openById(CONFIG.MASTER_SHEET_ID).getSheetByName('Monthly_Snapshots');
  const existing = snapshotSheet.getRange(2,1,snapshotSheet.getLastRow()-1,1).getValues().flat();
  if (!existing.includes(month)) {
    snapshotSheet.appendRow([month,data.timestamp,data.index.NAV,data.index.IIV,data.index.premium,data.index.netOrders,data.index.netUnits,data.index.components,top5]);
  }
}

function getMonthlySnapshots() {
  const sheet = SpreadsheetApp.openById(CONFIG.MASTER_SHEET_ID).getSheetByName('Monthly_Snapshots');
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2,1,sheet.getLastRow()-1,9).getValues().map(r => ({
    month:r[0],date:r[1],NAV:r[2],IIV:r[3],premium:r[4],
    netOrders:r[5],netUnits:r[6],components:r[7],top5:r[8]
  })).reverse();
}

function getHistoricalData(month) {
  const sheet = SpreadsheetApp.openById(CONFIG.MASTER_SHEET_ID).getSheetByName('History');
  const data = sheet.getDataRange().getValues();
  return data.filter((r,i) => i>0 && Utilities.formatDate(new Date(r[0]),CONFIG.TIMEZONE,'yyyy-MM') === month)
             .map(r => ({time:Utilities.formatDate(new Date(r[0]),CONFIG.TIMEZONE,'HH:mm'),NAV:r[1],IIV:r[2]}));
}

// ✅ إصلاح: updateHistory تكتب في History فقط — مش في كل زيارة للداشبورد
function updateHistory() {
  const data = getData();
  const sheet = SpreadsheetApp.openById(CONFIG.MASTER_SHEET_ID).getSheetByName('History');
  sheet.appendRow([new Date(),data.index.NAV,data.index.IIV,data.index.premium,
    data.index.netOrders,data.index.netUnits,data.index.grossOrders,data.index.redemptionOrders]);
  updateParticipantValues(parseFloat(data.index.NAV));
  // ✅ جديد: إرسال إشعار ساعي لـ Render
  sendNotificationToRender('hourly_update', {
    NAV: data.index.NAV,
    change: data.index.change,
    changePercent: data.index.changePercent,
    netOrders: data.index.netOrders,
    timestamp: data.timestamp
  });
}

// ✅ جديد: إرسال إشعار يوم 21
function saveMonthlySnapshotWithNotification() {
  saveMonthlySnapshot();
  const data = getData();

  // بيانات شخصية لكل مشارك
  const participantsData = {};
  const sheet = SpreadsheetApp.openById(CONFIG.MASTER_SHEET_ID).getSheetByName('Participants');
  if (sheet.getLastRow() > 1) {
    sheet.getDataRange().getValues().slice(1).forEach(row => {
      if (row[1] === 'active') {
        participantsData[row[0]] = {
          currentValue: parseFloat(row[5]).toFixed(2),
          pnl: parseFloat(row[6]).toFixed(2)
        };
      }
    });
  }

  // إشعار عام + شخصي
  sendNotificationToRender('monthly_snapshot', {
    NAV: data.index.NAV,
    IIV: data.index.IIV,
    top5: data.trending.slice(0,5).map(x=>x[0]).join(', '),
    timestamp: data.timestamp,
    participants_data: participantsData
  });

  // إيميل لكل مشارك يوم 21
  sendMonthlyEmailsToParticipants(data);
}

// ✅ جديد: إيميل شهري لكل مشارك
function sendMonthlyEmailsToParticipants(data) {
  const sheet = SpreadsheetApp.openById(CONFIG.MASTER_SHEET_ID).getSheetByName('Participants');
  if (sheet.getLastRow() < 2) return;
  const rows = sheet.getDataRange().getValues().slice(1);
  rows.forEach(row => {
    const email = row[0];
    const status = row[1];
    if (status !== 'active') return;
    const currentValue = parseFloat(row[5]).toFixed(2);
    const pnl = parseFloat(row[6]);
    const pnlText = pnl >= 0 ? '+$' + pnl.toFixed(2) + ' ربح' : '-$' + Math.abs(pnl).toFixed(2) + ' خسارة';
    const top5 = data.trending.slice(0,5).map(x=>x[0]).join('، ');
    try {
      MailApp.sendEmail({
        to: email,
        subject: CONFIG.INDEX_TICKER + ' - تقرير يوم 21',
        body: 'تقرير صندوق ' + CONFIG.INDEX_TICKER + '\n\n' +
          'قيمة حصتك: $' + currentValue + '\n' +
          'الربح/الخسارة: ' + pnlText + '\n' +
          'NAV: $' + data.index.NAV + '\n' +
          'Top5: ' + top5 + '\n\n' +
          'افتح الداشبورد للتفاصيل.'
      });
    } catch(e) {}
  });
}

// ✅ جديد: إرسال بيانات لـ Render
function sendNotificationToRender(type, payload) {
  try {
    const participants = getAllParticipantEmails();
    UrlFetchApp.fetch(CONFIG.RENDER_URL + '/notify', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        secret: CONFIG.RENDER_SECRET,
        type: type,
        payload: payload,
        participants: participants
      }),
      muteHttpExceptions: true
    });
  } catch(e) {}
}

function getAllParticipantEmails() {
  const sheet = SpreadsheetApp.openById(CONFIG.MASTER_SHEET_ID).getSheetByName('Participants');
  if (sheet.getLastRow() < 2) return [];
  return sheet.getDataRange().getValues().slice(1)
    .filter(r => r[1] === 'active')
    .map(r => r[0]);
}

// ─────────────────────────────────────────────
// ✅ جديد: نظام المشاركين
// ─────────────────────────────────────────────

// حساب توزيع الـ$513 على البزنسات حسب الأوزان
function calcAllocation(weights) {
  const alloc = {};
  weights.forEach(w => {
    alloc[w.name] = parseFloat((parseFloat(w.weight) / 100 * CONFIG.SHARE_PRICE).toFixed(2));
  });
  return alloc;
}

// شراء حصة — المشارك يدخل الصندوق
function buyShare(email) {
  const master = SpreadsheetApp.openById(CONFIG.MASTER_SHEET_ID);
  const sheet = master.getSheetByName('Participants');
  const data = sheet.getDataRange().getValues();

  // التحقق من عدم الاشتراك المسبق
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === email && data[i][1] === 'active') {
      return {error: 'المشارك مسجل مسبقاً'};
    }
  }

  // التحقق من وجود حصة في السوق للشراء منها
  const marketSheet = master.getSheetByName('Market');
  const market = marketSheet.getDataRange().getValues();
  for (let i = 1; i < market.length; i++) {
    if (market[i][3] === 'available') {
      // شراء من السوق
      const sellerEmail = market[i][0];
      const sellerShareValue = parseFloat(market[i][1]);
      marketSheet.getRange(i+1,4).setValue('sold');
      marketSheet.getRange(i+1,5).setValue(email);
      marketSheet.getRange(i+1,6).setValue(new Date());

      const liveData = getData();
      const currentNAV = parseFloat(liveData.index.NAV);
      const alloc = JSON.stringify(calcAllocation(liveData.weights));

      sheet.appendRow([email,'active',currentNAV,new Date(),sellerShareValue,sellerShareValue,0,alloc]);
      cache.remove('lavndr_data');

      // إشعار شخصي للبائع: تمت عملية البيع
      sendNotificationToRender('share_sold', {
        seller_email: sellerEmail,
        buyer_email: email,
        shareValue: sellerShareValue
      });

      return {status:'purchased_from_market', from: sellerEmail, shareValue: sellerShareValue};
    }
  }

  // شراء مباشر من الصندوق
  const liveData = getData();
  const currentNAV = parseFloat(liveData.index.NAV);
  const alloc = JSON.stringify(calcAllocation(liveData.weights));
  sheet.appendRow([email,'active',currentNAV,new Date(),CONFIG.SHARE_PRICE,CONFIG.SHARE_PRICE,0,alloc]);
  cache.remove('lavndr_data');
  return {status:'bought', entryNAV: currentNAV, sharePrice: CONFIG.SHARE_PRICE};
}

// بيع حصة — يُعرض في السوق لمشارك آخر
function sellShare(email) {
  const master = SpreadsheetApp.openById(CONFIG.MASTER_SHEET_ID);
  const sheet = master.getSheetByName('Participants');
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === email && data[i][1] === 'active') {
      const currentValue = parseFloat(data[i][5]);
      sheet.getRange(i+1,2).setValue('selling');
      const marketSheet = master.getSheetByName('Market');
      marketSheet.appendRow([email, currentValue, new Date(), 'available', '', '']);
      cache.remove('lavndr_data');

      // إشعار عام: حصة جديدة في السوق
      sendNotificationToRender('market_listing', {
        shareValue: currentValue
      });

      return {status:'listed', shareValue: currentValue};
    }
  }
  return {error: 'المشارك غير موجود أو غير نشط'};
}

// تحديث قيم جميع المشاركين مع تغير NAV
function updateParticipantValues(currentNAV) {
  if (currentNAV <= 0) return;
  const master = SpreadsheetApp.openById(CONFIG.MASTER_SHEET_ID);
  const sheet = master.getSheetByName('Participants');
  if (sheet.getLastRow() < 2) return;
  const data = sheet.getDataRange().getValues();
  const liveData = getData();
  const alloc = JSON.stringify(calcAllocation(liveData.weights));

  for (let i = 1; i < data.length; i++) {
    if (data[i][1] !== 'active' && data[i][1] !== 'selling') continue;
    const entryNAV = parseFloat(data[i][2]);
    const sharePrice = parseFloat(data[i][4]);
    if (entryNAV <= 0) continue;
    // نسبة الملكية = sharePrice / entryNAV
    const ownership = sharePrice / entryNAV;
    // القيمة الحالية = ownership × currentNAV
    const currentValue = parseFloat((ownership * currentNAV).toFixed(2));
    const pnl = parseFloat((currentValue - sharePrice).toFixed(2));
    sheet.getRange(i+1,6).setValue(currentValue);
    sheet.getRange(i+1,7).setValue(pnl);
    sheet.getRange(i+1,8).setValue(alloc);
  }
}

// بيانات مشارك واحد
function getParticipantInfo(email) {
  const master = SpreadsheetApp.openById(CONFIG.MASTER_SHEET_ID);
  const sheet = master.getSheetByName('Participants');
  if (sheet.getLastRow() < 2) return null;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === email) {
      const alloc = JSON.parse(data[i][7] || '{}');
      return {
        email: data[i][0],
        status: data[i][1],
        entryNAV: parseFloat(data[i][2]).toFixed(2),
        entryDate: data[i][3],
        sharePrice: parseFloat(data[i][4]).toFixed(2),
        currentValue: parseFloat(data[i][5]).toFixed(2),
        pnl: parseFloat(data[i][6]).toFixed(2),
        pnlPercent: data[i][4] > 0? ((data[i][6]/data[i][4])*100).toFixed(2) : '0.00',
        allocation: alloc
      };
    }
  }
  return null;
}

// السوق الداخلي — الحصص المعروضة للبيع
function getMarket() {
  const sheet = SpreadsheetApp.openById(CONFIG.MASTER_SHEET_ID).getSheetByName('Market');
  if (sheet.getLastRow() < 2) return [];
  return sheet.getDataRange().getValues().slice(1)
    .filter(r => r[3] === 'available')
    .map(r => ({seller:r[0], shareValue:r[1], listDate:r[2]}));
}

// ─────────────────────────────────────────────
// Ticker & Basket
// ─────────────────────────────────────────────
function getTicker(name) {
  let ticker = props.getProperty('TICKER_' + name);
  if (!ticker) {
    const clean = name.replace(/[^ء-يa-zA-Z0-9]/g,'').substring(0,4).toUpperCase();
    ticker = clean + Math.floor(Math.random()*90+10);
    props.setProperty('TICKER_' + name, ticker);
  }
  return ticker;
}

function generateBasketFile(productCount) {
  const total = Object.values(productCount).reduce((a,b) => a+b, 0);
  if (total === 0) return {basket:{},cashComponent:0};
  const basket = {};
  let cashComponent = 0;
  Object.entries(productCount).forEach(([name,count]) => {
    const exactShares = (count/total)*CONFIG.ORDERS_PER_UNIT;
    const shares = Math.floor(exactShares);
    const remainder = exactShares - shares;
    if (shares > 0) basket[getTicker(name)] = shares;
    cashComponent += remainder * CONFIG.ORDER_VALUE;
  });
  return {basket, cashComponent:parseFloat(cashComponent.toFixed(2))};
}

// ✅ إصلاح: عطلة السودان جمعة(5) وسبت(6)
function getSettlementDate() {
  const now = new Date();
  let settlement = new Date(now);
  let daysAdded = 0;
  while (daysAdded < CONFIG.SETTLEMENT_DAYS) {
    settlement.setDate(settlement.getDate()+1);
    const day = settlement.getDay();
    if (day !== 5 && day !== 6) daysAdded++;
  }
  return Utilities.formatDate(settlement, CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

// ✅ إصلاح: capWeights تتكرر حتى لا يوجد تجاوز
function capWeights(weights) {
  let changed = true;
  while (changed) {
    changed = false;
    let excess = 0;
    weights.forEach(w => {
      if (parseFloat(w.weight) > CONFIG.MAX_COMPONENT_WEIGHT*100) {
        excess += parseFloat(w.weight) - CONFIG.MAX_COMPONENT_WEIGHT*100;
        w.weight = CONFIG.MAX_COMPONENT_WEIGHT*100;
        changed = true;
      }
    });
    if (excess > 0) {
      const remaining = weights.filter(w => parseFloat(w.weight) < CONFIG.MAX_COMPONENT_WEIGHT*100);
      if (remaining.length > 0) {
        const perItem = excess/remaining.length;
        remaining.forEach(w => w.weight = parseFloat(w.weight)+perItem);
      }
    }
  }
  return weights;
}

function readSheetWithTimeout(sheetId) {
  const startTime = Date.now();
  try {
    const lastRow = parseInt(props.getProperty('ROW_'+sheetId)||'1');
    const ss = SpreadsheetApp.openById(sheetId);
    if (Date.now()-startTime > CONFIG.SHEET_TIMEOUT_MS) return null;
    const sheet = ss.getSheetByName('Orders');
    if (Date.now()-startTime > CONFIG.SHEET_TIMEOUT_MS) return null;
    const lastSheetRow = sheet.getLastRow();
    if (lastSheetRow <= lastRow) return {data:[],lastRow:lastRow};
    if (Date.now()-startTime > CONFIG.SHEET_TIMEOUT_MS) return null;
    const data = sheet.getRange(lastRow+1,1,lastSheetRow-lastRow,8).getValues();
    return {data:data,lastRow:lastSheetRow};
  } catch(e) { return null; }
}

// ─────────────────────────────────────────────
// getData — القلب
// ─────────────────────────────────────────────
function getData() {
  const cached = cache.get('lavndr_data');
  if (cached) return JSON.parse(cached);

  // ✅ إصلاح: كل الأرقام تراكمية من props
  const productCount = JSON.parse(props.getProperty('LAST_COUNTS')||'{}');
  let grossOrders = parseInt(props.getProperty('GROSS_ORDERS')||'0');
  let redemptionOrders = parseInt(props.getProperty('REDEMPTION_ORDERS')||'0');
  const apActivity = JSON.parse(props.getProperty('AP_ACTIVITY')||'{}');

  BUSINESS_SHEETS.forEach(sheetId => {
    const result = readSheetWithTimeout(sheetId);
    if (!result) return;
    const {data,lastRow} = result;
    if (data.length > 0) {
      data.forEach(row => {
        const item = row[1];
        const type = row[6]||'BUY';
        const ap = row[7]||'AP001';
        if (item) {
          if (type === 'REDEEM') {
            redemptionOrders++;
            productCount[item] = Math.max(0,(productCount[item]||0)-1);
          } else {
            productCount[item] = (productCount[item]||0)+1;
            grossOrders++;
          }
          apActivity[ap] = (apActivity[ap]||0)+1;
        }
      });
      props.setProperty('ROW_'+sheetId, lastRow);
    }
  });

  // ✅ إصلاح: حفظ كل الأرقام التراكمية
  props.setProperty('LAST_COUNTS', JSON.stringify(productCount));
  props.setProperty('GROSS_ORDERS', grossOrders.toString());
  props.setProperty('REDEMPTION_ORDERS', redemptionOrders.toString());
  props.setProperty('AP_ACTIVITY', JSON.stringify(apActivity));

  // ✅ إصلاح: NAV من totalOrders الحقيقي
  const totalOrders = Object.values(productCount).reduce((a,b) => a+b, 0);
  const netOrders = grossOrders - redemptionOrders;
  const allProducts = Object.entries(productCount).filter(([k,v]) => v>0).sort((a,b) => b[1]-a[1]);
  const NAV = totalOrders * CONFIG.ORDER_VALUE;
  const basketData = generateBasketFile(productCount);
  const netUnits = Math.floor(totalOrders/CONFIG.ORDERS_PER_UNIT);
  const IIV = (netUnits*CONFIG.ORDERS_PER_UNIT*CONFIG.ORDER_VALUE)+basketData.cashComponent;
  const premium = NAV > 0? ((IIV-NAV)/NAV*100) : 0;

  // ✅ إصلاح: الأوزان من totalOrders
  let weights = allProducts.map(([name,count]) => ({
    name:name, ticker:getTicker(name), count:count,
    weight: totalOrders > 0? (count/totalOrders*100) : 0,
    value: (count*CONFIG.ORDER_VALUE).toFixed(2)
  }));
  weights = capWeights(weights);

  // ✅ إصلاح: History لا تُكتب هنا
  const historySheet = SpreadsheetApp.openById(CONFIG.MASTER_SHEET_ID).getSheetByName('History');
  const now = new Date();
  const lastRow = historySheet.getLastRow();
  if (lastRow < 2) {
    // لا يوجد بيانات بعد — أضف صف أولي
    historySheet.appendRow([now, 0, 0, 0, 0, 0, 0, 0]);
  }
  const lastRows = historySheet.getRange(Math.max(2,historySheet.getLastRow()-29),1,Math.min(30,Math.max(1,historySheet.getLastRow()-1)),3).getValues();
  const values = lastRows.map(r => r[1]);
  const returns = [];
  for (let i=1;i<values.length;i++) {
    if (values[i-1]>0) returns.push((values[i]-values[i-1])/values[i-1]);
  }
  const avg = returns.reduce((a,b)=>a+b,0)/returns.length||0;
  const variance = returns.reduce((a,b)=>a+Math.pow(b-avg,2),0)/returns.length||0;
  const volatility = Math.sqrt(variance*252)*100;

  const today = Utilities.formatDate(now,CONFIG.TIMEZONE,'yyyy-MM-dd');
  const todayValues = lastRows.filter(r=>Utilities.formatDate(new Date(r[0]),CONFIG.TIMEZONE,'yyyy-MM-dd')===today).map(r=>r[1]);
  const dayHigh = todayValues.length? Math.max(...todayValues) : NAV;
  const dayLow = todayValues.length? Math.min(...todayValues) : NAV;
  const prevNAV = lastRows.length>1? lastRows[lastRows.length-2][1] : NAV;
  const change = NAV-prevNAV;
  const changePercent = prevNAV>0? (change/prevNAV*100) : 0;

  // ✅ جديد: إحصاء المشاركين
  const participantsSheet = SpreadsheetApp.openById(CONFIG.MASTER_SHEET_ID).getSheetByName('Participants');
  const participantsCount = participantsSheet.getLastRow()-1;
  const activeCount = participantsSheet.getLastRow()>1?
    participantsSheet.getDataRange().getValues().slice(1).filter(r=>r[1]==='active').length : 0;
  const poolValue = parseFloat((participantsCount * CONFIG.SHARE_PRICE).toFixed(2));
  const marketList = getMarket();

  const result = {
    mode:'live',
    indexTicker:CONFIG.INDEX_TICKER,
    timestamp:Utilities.formatDate(now,CONFIG.TIMEZONE,"yyyy-MM-dd'T'HH:mm:ss"),
    settlementDate:getSettlementDate(),
    settlementCycle:'T+'+CONFIG.SETTLEMENT_DAYS,
    maxCapacityOrders:CONFIG.BUSINESS_COUNT*CONFIG.MAX_ORDERS_PER_BUSINESS,
    maxCapacityValue:(CONFIG.BUSINESS_COUNT*CONFIG.MAX_ORDERS_PER_BUSINESS*CONFIG.ORDER_VALUE).toFixed(2),
    maxCapacityUnits:(CONFIG.BUSINESS_COUNT*CONFIG.MAX_ORDERS_PER_BUSINESS)/CONFIG.ORDERS_PER_UNIT,
    cashInLieu:basketData.cashComponent,
    trending:allProducts.slice(0,10).map(([name,count])=>[getTicker(name),count]),
    weights:weights.slice(0,CONFIG.MAX_TABLE_ROWS),
    totalComponents:allProducts.length,
    monthlySnapshots:getMonthlySnapshots(),
    authorizedParticipants:Object.entries(apActivity).map(([code,orders])=>({
      code:code, name:AUTHORIZED_PARTICIPANTS[code]||code, orders:orders
    })),
    // ✅ جديد: بيانات الصندوق الاستثماري
    fund: {
      totalParticipants: participantsCount,
      activeParticipants: activeCount,
      poolValue: poolValue,
      sharePrice: CONFIG.SHARE_PRICE,
      marketListings: marketList.length,
      market: marketList
    },
    index:{
      NAV:NAV.toFixed(2), IIV:IIV.toFixed(2), premium:premium.toFixed(2),
      percent:((NAV/(CONFIG.BUSINESS_COUNT*CONFIG.MAX_ORDERS_PER_BUSINESS*CONFIG.ORDER_VALUE))*100).toFixed(2),
      change:change.toFixed(2), changePercent:changePercent.toFixed(2),
      dayHigh:dayHigh.toFixed(2), dayLow:dayLow.toFixed(2), volatility:volatility.toFixed(2),
      netOrders:netOrders, netUnits:netUnits,
      unitValue:CONFIG.UNIT_VALUE.toFixed(2), orderValue:CONFIG.ORDER_VALUE.toFixed(2),
      grossOrders:grossOrders, redemptionOrders:redemptionOrders, components:allProducts.length
    },
    history:lastRows.map(h=>({time:Utilities.formatDate(new Date(h[0]),CONFIG.TIMEZONE,'HH:mm'),NAV:h[1],IIV:h[2]}))
  };

  cache.put('lavndr_data', JSON.stringify(result), CONFIG.CACHE_TTL/1000);
  return result;
}

// ─────────────────────────────────────────────
// HTTP Handlers
// ─────────────────────────────────────────────
function doGet(e) {
  const userEmail = e.parameter.email || Session.getActiveUser().getEmail();

  if (!CONFIG.ALLOWED_EMAILS.includes(userEmail)) {
    return HtmlService.createHtmlOutput(
      '<div style="text-align: center; padding-top: 50px;">' +
      '<h1>Unauthorized Access</h1>' +
      '<p>Your email (' + (userEmail || 'not provided') + ') is not permitted to view this dashboard.</p>' +
      '<p>Please contact support if you believe this is an error.</p>' +
      '</div>'
    ).setTitle('Unauthorized');
  }

  if (e.parameter.key !== CONFIG.API_KEY) {
    return ContentService.createTextOutput(JSON.stringify({error:'Unauthorized'})).setMimeType(ContentService.MimeType.JSON);
  }

  if (!e.parameter.action) {
    try {
      const userEmail = Session.getActiveUser().getEmail();
      if (!ALLOWED_EMAILS.includes(userEmail)) {
        return HtmlService.createHtmlOutput('<h2 style="text-align:center;margin-top:100px;color:red;">غير مصرح لك بدخول النظام</h2>').setTitle('Access Denied');
      }
    } catch(err) {}
  }

  if (e.parameter.action === 'data') {
    return ContentService.createTextOutput(JSON.stringify(getData())).setMimeType(ContentService.MimeType.JSON);
  }

  if (e.parameter.action === 'month') {
    const month = e.parameter.month;
    const snap = getMonthlySnapshots().find(s=>s.month===month);
    return ContentService.createTextOutput(JSON.stringify({
      mode:'historical', month:month, snapshot:snap||null, history:getHistoricalData(month)
    })).setMimeType(ContentService.MimeType.JSON);
  }

  if (e.parameter.action === 'basket') {
    const basketData = generateBasketFile(JSON.parse(props.getProperty('LAST_COUNTS')||'{}'));
    return ContentService.createTextOutput(JSON.stringify({
      indexTicker:CONFIG.INDEX_TICKER,
      asOf:Utilities.formatDate(new Date(),CONFIG.TIMEZONE,"yyyy-MM-dd'T'HH:mm:ss"),
      settlementDate:getSettlementDate(), settlementCycle:'T+'+CONFIG.SETTLEMENT_DAYS,
      ordersPerUnit:CONFIG.ORDERS_PER_UNIT, basket:basketData.basket, cashInLieu:basketData.cashComponent
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // ✅ جديد: بيانات مشارك
  if (e.parameter.action === 'participant') {
    const email = e.parameter.email;
    if (!email) return ContentService.createTextOutput(JSON.stringify({error:'email required'})).setMimeType(ContentService.MimeType.JSON);
    return ContentService.createTextOutput(JSON.stringify(getParticipantInfo(email)||{error:'not found'})).setMimeType(ContentService.MimeType.JSON);
  }

  // ✅ جديد: السوق الداخلي
  if (e.parameter.action === 'market') {
    return ContentService.createTextOutput(JSON.stringify(getMarket())).setMimeType(ContentService.MimeType.JSON);
  }

  return HtmlService.createHtmlOutput(DASHBOARD_HTML).setTitle(CONFIG.INDEX_TICKER+' Dashboard').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  if (e.parameter.key !== CONFIG.API_KEY) {
    return ContentService.createTextOutput(JSON.stringify({error:'Unauthorized'})).setMimeType(ContentService.MimeType.JSON);
  }

  try {
    const data = JSON.parse(e.postData.contents);

    // ✅ جديد: شراء حصة
    if (data.action === 'buy') {
      if (!data.email) return ContentService.createTextOutput(JSON.stringify({error:'email required'})).setMimeType(ContentService.MimeType.JSON);
      return ContentService.createTextOutput(JSON.stringify(buyShare(data.email))).setMimeType(ContentService.MimeType.JSON);
    }

    // ✅ جديد: بيع حصة
    if (data.action === 'sell') {
      if (!data.email) return ContentService.createTextOutput(JSON.stringify({error:'email required'})).setMimeType(ContentService.MimeType.JSON);
      return ContentService.createTextOutput(JSON.stringify(sellShare(data.email))).setMimeType(ContentService.MimeType.JSON);
    }

    // AP Orders
    const apCode = data.apCode;
    const type = data.type;
    const units = parseInt(data.units);

    if (!AUTHORIZED_PARTICIPANTS[apCode]||!['CREATE','REDEEM'].includes(type)||units<=0||units>10000) {
      return ContentService.createTextOutput(JSON.stringify({error:'Invalid AP or units'})).setMimeType(ContentService.MimeType.JSON);
    }

    const basketData = generateBasketFile(JSON.parse(props.getProperty('LAST_COUNTS')||'{}'));
    const settlementDate = getSettlementDate();
    SpreadsheetApp.openById(CONFIG.MASTER_SHEET_ID).getSheetByName('AP_Orders')
      .appendRow([new Date(),apCode,type,units,basketData.cashComponent,settlementDate,'PENDING']);
    cache.remove('lavndr_data');

    return ContentService.createTextOutput(JSON.stringify({
      status:'PENDING', units:units, basket:basketData.basket,
      cashInLieu:basketData.cashComponent, settlementDate:settlementDate, settlementCycle:'T+'+CONFIG.SETTLEMENT_DAYS
    })).setMimeType(ContentService.MimeType.JSON);

  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({error:'Invalid payload'})).setMimeType(ContentService.MimeType.JSON);
  }
}

// ─────────────────────────────────────────────
// Dashboard HTML
// ─────────────────────────────────────────────
const DASHBOARD_HTML = `
<!DOCTYPE html>
<html dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body{max-width:1400px;margin:auto;padding:20px;background:#0d1117;color:#e6edf3;font-family:'Segoe UI',Arial;}
    .header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;border-bottom:2px solid #30363d;padding-bottom:15px;flex-wrap:wrap;gap:10px;}
    h1{margin:0;color:#ffcc00;font-size:24px;}
    h3{color:#ffcc00;}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:15px;margin-bottom:30px;}
    .card{background:#161b22;padding:15px;border-radius:8px;border:1px solid #30363d;}
    .label{font-size:12px;color:#8b949e;}
    .value{font-size:24px;font-weight:bold;}
    canvas{background:#161b22;padding:15px;border-radius:8px;border:1px solid #30363d;}
    table{width:100%;border-collapse:collapse;font-size:13px;background:#161b22;border-radius:8px;border:1px solid #30363d;}
    th{padding:12px;text-align:right;position:sticky;top:0;background:#21262d;}
    td{padding:10px;border-bottom:1px solid #21262d;}
    .btn-buy{background:#238636;color:#fff;border:none;padding:5px 12px;border-radius:4px;cursor:pointer;font-size:12px;}
    .btn-sell{background:#da3633;color:#fff;border:none;padding:5px 12px;border-radius:4px;cursor:pointer;font-size:12px;}
    .btn-buy:hover{background:#2ea043;}
    .btn-sell:hover{background:#f85149;}
    button.main{background:#238636;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;}
    select{background:#21262d;color:#e6edf3;border:1px solid #30363d;padding:8px 12px;border-radius:6px;}
    #loading{text-align:center;padding:100px;color:#ffcc00;font-size:18px;}
    #errorBox{display:none;text-align:center;padding:50px;color:#f85149;font-size:16px;}
    .pnl-pos{color:#3fb950;} .pnl-neg{color:#f85149;}
    .participant-card{background:#0d2818;border:1px solid #238636;padding:15px;border-radius:8px;margin-bottom:20px;}
    .market-card{background:#1c1107;border:1px solid #9e6a03;padding:15px;border-radius:8px;margin-bottom:20px;}
    @media(max-width:768px){.grid{grid-template-columns:1fr 1fr;}table{font-size:11px;}h1{font-size:18px;}.value{font-size:18px;}body{padding:10px;}}
    .spinner{border:3px solid #30363d;border-top:3px solid #ffcc00;border-radius:50%;width:40px;height:40px;animation:spin 1s linear infinite;margin:auto;}
    @keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
  </style>
</head>
<body>
  <div class="header">
    <h1 id="indexTitle">LAVNDR120</h1>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
      <select id="monthSelector" onchange="loadMonth(this.value)"><option value="">الوضع الحالي</option></select>
      <div id="lastUpdate" style="font-size:12px;color:#8b949e;"></div>
      <button class="main" onclick="exportCSV()">تصدير CSV</button>
    </div>
  </div>

  <div id="loading"><div class="spinner"></div><div style="margin-top:20px;">جاري تحميل الداتا...</div></div>
  <div id="errorBox"></div>

  <div id="content" style="display:none;">
    <div id="keyMetrics" class="grid"></div>

    <!-- ✅ جديد: بانيل الصندوق -->
    <div id="fundPanel" class="card" style="margin-bottom:20px;"></div>

    <!-- ✅ جديد: بانيل المشارك الشخصي -->
    <div id="participantPanel" style="display:none;" class="participant-card"></div>

    <!-- ✅ جديد: السوق الداخلي -->
    <div id="marketPanel" style="display:none;" class="market-card"></div>

    <div id="apPanel" class="card" style="margin-bottom:20px;"></div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:30px;">
      <canvas id="circleChart"></canvas>
      <canvas id="trendSlice"></canvas>
    </div>
    <canvas id="etfIndex" style="height:400px;margin-bottom:30px;"></canvas>

    <h3>مكونات <span id="indexTicker"></span> - الأوزان اللحظية</h3>
    <div id="componentCount" style="font-size:12px;color:#8b949e;margin-bottom:10px;"></div>
    <div style="max-height:500px;overflow-y:auto;">
      <table id="weightsTable"><thead><tr>
        <th>الرمز</th><th>المنتج</th><th style="text-align:center;">الطلبات</th>
        <th style="text-align:center;">الوزن</th><th style="text-align:center;">نصيبك $</th>
        <th style="text-align:right;">شراء / بيع</th>
      </tr></thead><tbody></tbody></table>
    </div>
  </div>

<script>
  // ✅ إصلاح: API_URL صحيح بغض النظر عن params
  const baseUrl = window.location.href.split('?')[0];
  const urlParams = new URLSearchParams(window.location.search);
  const apiKey = urlParams.get('key');
  const userEmail = urlParams.get('email') || '';
  const API_URL = 'https://script.google.com/macros/s/AKfycbyLUuxkaKjXUVz0hCtFdDEgW4MzYMpwJPW9TNQbKVP0ZzAMQpuoFAVfGDRv2vYsmVnNyQ/exec?key=LAVNDR_SECRET_KEY_2026&action=data';

  let etfChart, doughnutChart, pieChart, currentMode='live', globalData=null;

  function loadData() {
    document.getElementById('loading').style.display = 'block';
    document.getElementById('content').style.display = 'none';
    document.getElementById('errorBox').style.display = 'none';

    fetch(API_URL)
      .then(res=>res.json())
      .then(data=>{
        if(data.error) throw new Error(data.error);
        globalData = data;
        document.getElementById('loading').style.display = 'none';
        document.getElementById('content').style.display = 'block';

        const selector = document.getElementById('monthSelector');
        if(selector.options.length===1 && data.monthlySnapshots) {
          data.monthlySnapshots.forEach(s=>{
            selector.innerHTML += \`<option value="\${s.month}">\${s.month} - NAV: $\${s.NAV}</option>\`;
          });
        }
        renderDashboard(data);

        // تحميل بيانات المشارك إن وجد إيميل
        if(userEmail) loadParticipant();
      })
      .catch(err=>{
        document.getElementById('loading').style.display = 'none';
        document.getElementById('errorBox').style.display = 'block';
        document.getElementById('errorBox').innerHTML = 'فشل الاتصال بالنظام';
      });
  }

  function loadParticipant() {
    fetch(baseUrl + '?key=' + apiKey + '&action=participant&email=' + encodeURIComponent(userEmail))
      .then(res=>res.json())
      .then(p=>{
        const panel = document.getElementById('participantPanel');
        if(p.error) {
          panel.style.display = 'block';
          panel.innerHTML = \`
            <div style="color:#ffcc00;margin-bottom:10px;">حصتك في الصندوق</div>
            <div style="color:#8b949e;">لم تشترك بعد</div>
            <button class="btn-buy" style="margin-top:10px;" onclick="buyShare()">اشتري حصة — $\${globalData.fund.sharePrice}</button>
          \`;
          return;
        }
        const pnlColor = parseFloat(p.pnl)>=0 ? '#3fb950':'#f85149';
        panel.style.display = 'block';
        panel.innerHTML = \`
          <div style="color:#ffcc00;margin-bottom:12px;">حصتك في الصندوق</div>
          <div class="grid" style="margin-bottom:10px;">
            <div><div class="label">سعر الدخول</div><div class="value" style="font-size:18px;">$\${p.sharePrice}</div></div>
            <div><div class="label">القيمة الحالية</div><div class="value" style="font-size:18px;">$\${p.currentValue}</div></div>
            <div><div class="label">الربح / الخسارة</div>
              <div class="value" style="font-size:18px;color:\${pnlColor}">\${parseFloat(p.pnl)>=0?'+':''}\${p.pnl} (\${p.pnlPercent}%)</div></div>
            <div><div class="label">NAV وقت الدخول</div><div class="value" style="font-size:16px;">$\${p.entryNAV}</div></div>
          </div>
          \${p.status==='active'?
            \`<button class="btn-sell" onclick="sellShare()">بيع حصتي في السوق</button>\` :
            \`<div style="color:#ffa657;">حصتك معروضة للبيع في السوق</div>\`
          }
        \`;
      });
  }

  function buyShare() {
    if(!confirm('تأكيد شراء حصة بـ $' + (globalData?globalData.fund.sharePrice:513) + '؟')) return;
    fetch(baseUrl + '?key=' + apiKey, {
      method:'POST',
      body: JSON.stringify({action:'buy', email:userEmail})
    }).then(r=>r.json()).then(res=>{
      if(res.error) { alert('خطأ: ' + res.error); return; }
      alert('تم الشراء بنجاح ✓');
      loadData();
    });
  }

  function sellShare() {
    if(!confirm('تأكيد عرض حصتك للبيع في السوق الداخلي؟')) return;
    fetch(baseUrl + '?key=' + apiKey, {
      method:'POST',
      body: JSON.stringify({action:'sell', email:userEmail})
    }).then(r=>r.json()).then(res=>{
      if(res.error) { alert('خطأ: ' + res.error); return; }
      alert('تم عرض حصتك في السوق ✓');
      loadData();
    });
  }

  function loadMonth(month) {
    if(!month) { loadData(); return; }
    currentMode = 'historical';
    document.getElementById('loading').style.display = 'block';
    document.getElementById('content').style.display = 'none';

    fetch(baseUrl + '?key=' + apiKey + '&action=month&month=' + month)
      .then(res=>res.json())
      .then(data=>{
        document.getElementById('loading').style.display = 'none';
        document.getElementById('content').style.display = 'block';
        if(data.snapshot) renderHistorical(data);
      }).catch(err=>console.error(err));
  }

  function renderDashboard(data) {
    currentMode = 'live';
    document.getElementById('indexTitle').textContent = data.indexTicker + ' - ETF السودان الاستهلاكي';
    document.getElementById('indexTicker').textContent = data.indexTicker;
    document.getElementById('lastUpdate').textContent = 'آخر تحديث: ' + data.timestamp.split('T')[1];
    document.getElementById('componentCount').textContent = 'عرض ' + data.weights.length + ' من ' + data.totalComponents + ' مكون';
    const color = parseFloat(data.index.change)>=0? '#3fb950':'#f85149';

    document.getElementById('keyMetrics').innerHTML = \`
      <div class="card"><div class="label">NAV</div>
        <div class="value" style="color:\${color}">$\${data.index.NAV}</div>
        <div style="font-size:12px;color:\${color}">\${parseFloat(data.index.change)>=0?'+':''}\${data.index.change} (\${data.index.changePercent}%)</div></div>
      <div class="card"><div class="label">IIV</div>
        <div class="value" style="font-size:20px">$\${data.index.IIV}</div>
        <div class="label">\${data.index.netUnits} وحدة</div></div>
      <div class="card"><div class="label">Premium / Discount</div>
        <div class="value" style="font-size:20px;color:\${parseFloat(data.index.premium)>=0?'#3fb950':'#f85149'}">\${data.index.premium}%</div></div>
      <div class="card"><div class="label">Cash in Lieu</div>
        <div class="value" style="font-size:20px;color:#ffcc00">$\${data.cashInLieu}</div>
        <div class="label">\${data.settlementCycle} - \${data.settlementDate}</div></div>
      <div class="card"><div class="label">Capacity</div>
        <div class="value" style="font-size:18px">\${data.index.percent}%</div>
        <div class="label">\${data.index.netOrders} / \${data.maxCapacityOrders}</div></div>
      <div class="card"><div class="label">الوحدات</div>
        <div class="value" style="font-size:18px">\${data.index.netUnits} / \${data.maxCapacityUnits}</div></div>
      <div class="card"><div class="label">Volatility</div>
        <div class="value" style="color:#da3633">\${data.index.volatility}%</div></div>
      <div class="card"><div class="label">High / Low</div>
        <div class="value" style="font-size:18px">$\${data.index.dayHigh} / $\${data.index.dayLow}</div></div>
    \`;

    // ✅ جديد: بانيل الصندوق
    document.getElementById('fundPanel').innerHTML = \`
      <div style="color:#ffcc00;margin-bottom:10px;">الصندوق الاستثماري</div>
      <div style="display:flex;gap:30px;flex-wrap:wrap;">
        <div><div class="label">المشاركون النشطون</div><div style="font-size:20px;font-weight:bold;">\${data.fund.activeParticipants} / 120</div></div>
        <div><div class="label">إجمالي الصندوق</div><div style="font-size:20px;font-weight:bold;color:#ffcc00;">$\${data.fund.poolValue}</div></div>
        <div><div class="label">سعر الحصة</div><div style="font-size:20px;font-weight:bold;">$\${data.fund.sharePrice}</div></div>
        <div><div class="label">حصص معروضة للبيع</div><div style="font-size:20px;font-weight:bold;color:\${data.fund.marketListings>0?'#ffa657':'#8b949e'}">\${data.fund.marketListings}</div></div>
      </div>
    \`;

    // ✅ جديد: السوق الداخلي
    const marketPanel = document.getElementById('marketPanel');
    if(data.fund.market && data.fund.market.length > 0) {
      marketPanel.style.display = 'block';
      marketPanel.innerHTML = '<div style="color:#ffa657;margin-bottom:10px;">السوق الداخلي — حصص للبيع</div>' +
        data.fund.market.map(m => \`
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #30363d;">
            <div style="color:#8b949e;font-size:13px;">\${m.seller}</div>
            <div style="color:#ffcc00;font-weight:bold;">$\${m.shareValue}</div>
            \${userEmail && userEmail!==m.seller?
              \`<button class="btn-buy" onclick="buyShare()">شراء</button>\` :
              '<div style="color:#8b949e;font-size:12px;">أنت</div>'
            }
          </div>
        \`).join('');
    } else {
      marketPanel.style.display = 'none';
    }

    document.getElementById('apPanel').innerHTML =
      '<div style="font-size:12px;color:#ffcc00;margin-bottom:8px;">Authorized Participants</div>' +
      data.authorizedParticipants.map(ap=>\`<span style="margin:0 15px 0 0;color:#8b949e;">\${ap.code}: \${ap.name} - \${ap.orders} طلب</span>\`).join('');

    // ✅ إصلاح: تدمير قبل رسم
    if(doughnutChart){doughnutChart.destroy();doughnutChart=null;}
    if(pieChart){pieChart.destroy();pieChart=null;}
    if(etfChart){etfChart.destroy();etfChart=null;}

    doughnutChart = new Chart(document.getElementById('circleChart'),{
      type:'doughnut',
      data:{labels:data.trending.map(x=>x[0]),datasets:[{data:data.trending.map(x=>x[1]),
        backgroundColor:['#ffcc00','#ff6b6b','#4ecdc4','#45b7d1','#96ceb4','#feca57','#ff9ff3','#54a0ff','#48dbfb','#1dd1a1']}]},
      options:{responsive:true,plugins:{legend:{position:'bottom',labels:{color:'#e6edf3',font:{size:10}}}}}
    });

    if(data.trending.length > 0) {
      const topItem = data.trending[0];
      pieChart = new Chart(document.getElementById('trendSlice'),{
        type:'pie',
        data:{labels:[topItem[0]+' 🔥',...data.trending.slice(1).map(x=>x[0])],
          datasets:[{data:[topItem[1],...data.trending.slice(1).map(x=>x[1])],
          backgroundColor:['#ffcc00',...Array(9).fill('#333')],offset:[20,0,0,0,0,0,0,0,0,0]}]},
        options:{responsive:true,plugins:{legend:{display:false}}}
      });
    }

    etfChart = new Chart(document.getElementById('etfIndex'),{
      type:'line',
      data:{labels:data.history.map(h=>h.time),datasets:[{
        label:data.indexTicker+' NAV',data:data.history.map(h=>h.NAV),
        borderColor:color,backgroundColor:color+'20',fill:true,tension:0.3,pointRadius:0}]},
      options:{responsive:true,maintainAspectRatio:false,animation:false,
        scales:{y:{min:0,max:parseFloat(data.maxCapacityValue),ticks:{color:'#8b949e'}},x:{ticks:{color:'#8b949e'}}},
        plugins:{legend:{labels:{color:'#e6edf3'}}}}
    });

    // ✅ جديد: عمود نصيبك + أزرار شراء/بيع
    const tbody = document.querySelector('#weightsTable tbody');
    tbody.innerHTML = '';
    data.weights.forEach(item=>{
      const rowColor = parseFloat(item.weight)>5? '#ffcc00':'#e6edf3';
      const myShare = (parseFloat(item.weight)/100*data.fund.sharePrice).toFixed(2);
      tbody.innerHTML += \`<tr title="\${item.name}">
        <td style="font-weight:bold;color:\${rowColor}">\${item.ticker}</td>
        <td style="color:#8b949e;">\${item.name}</td>
        <td style="text-align:center;">\${item.count}</td>
        <td style="text-align:center;font-weight:bold;color:\${rowColor}">\${item.weight.toFixed?item.weight.toFixed(2):item.weight}%</td>
        <td style="text-align:center;color:#ffcc00;">$\${myShare}</td>
        <td style="text-align:center;">
          \${userEmail?
            \`<button class="btn-buy" onclick="buyShare()" title="وافق على التوجيه">✓ موافق</button>\` :
            '<span style="color:#30363d;font-size:11px;">سجّل دخولك</span>'
          }
        </td>
      </tr>\`;
    });
  }

  function renderHistorical(data) {
    document.getElementById('indexTitle').textContent = data.indexTicker + ' - أرشيف ' + data.month;
    document.getElementById('lastUpdate').textContent = 'لقطة يوم 21';
    document.getElementById('componentCount').textContent = data.snapshot.components + ' مكون | Top5: ' + data.snapshot.top5;

    document.getElementById('keyMetrics').innerHTML = \`
      <div class="card"><div class="label">NAV يوم 21</div><div class="value" style="color:#ffcc00">$\${data.snapshot.NAV}</div></div>
      <div class="card"><div class="label">IIV يوم 21</div><div class="value" style="font-size:20px">$\${data.snapshot.IIV}</div></div>
      <div class="card"><div class="label">Premium يوم 21</div>
        <div class="value" style="font-size:20px;color:\${parseFloat(data.snapshot.premium)>=0?'#3fb950':'#f85149'}">\${data.snapshot.premium}%</div></div>
      <div class="card"><div class="label">الطلبات يوم 21</div><div class="value" style="font-size:18px">\${data.snapshot.netOrders}</div></div>
    \`;

    if(doughnutChart){doughnutChart.destroy();doughnutChart=null;}
    if(pieChart){pieChart.destroy();pieChart=null;}
    if(etfChart){etfChart.destroy();etfChart=null;}

    etfChart = new Chart(document.getElementById('etfIndex'),{
      type:'line',
      data:{labels:data.history.map(h=>h.time),datasets:[{
        label:data.indexTicker+' NAV '+data.month,data:data.history.map(h=>h.NAV),
        borderColor:'#ffcc00',backgroundColor:'#ffcc0020',fill:true,tension:0.3,pointRadius:0}]},
      options:{responsive:true,maintainAspectRatio:false,animation:false,
        scales:{y:{ticks:{color:'#8b949e'}},x:{ticks:{color:'#8b949e'}}},
        plugins:{legend:{labels:{color:'#e6edf3'}}}}
    });
  }

  function exportCSV(){
    fetch(API_URL).then(res=>res.json()).then(data=>{
      let csv = 'Ticker,Product,Orders,Weight%,MyShare$\\n';
      data.weights.forEach(w=>{
        const myShare=(parseFloat(w.weight)/100*data.fund.sharePrice).toFixed(2);
        csv += \`\${w.ticker},\${w.name},\${w.count},\${w.weight},\${myShare}\\n\`;
      });
      const blob = new Blob([csv],{type:'text/csv'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'LAVNDR120_' + new Date().toISOString().split('T')[0] + '.csv';
      a.click();
    });
  }

  loadData();
  setInterval(loadData, 3600000);
</script>
</body></html>
`;
