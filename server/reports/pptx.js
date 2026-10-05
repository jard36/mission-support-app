const fs = require('fs');
const path = require('path');
const PptxGenJS = require('pptxgenjs');

function createPptxService({ filterQuarterEntries, parseSupportSlotStatuses, normalizeSlotLabels }) {
  function compactPptStatus(value) {
    if (!value) return '';
    return String(value).replace(/\s+/g, ' ').trim();
  }

  function pptStatusDisplay(value, entry = null) {
    const text = compactPptStatus(value);
    if (!text) return '';
    const parsed = parseSupportSlotStatuses(text);
    if (!parsed.length) return text;
    const disabled = new Set(normalizeSlotLabels(entry?.disabledSupportSlots));
    return parsed.filter(slot => !disabled.has(slot.label))
      .map(slot => `${slot.label}. ${slot.checked ? '✓' : ''}`.trimEnd()).join('    ');
  }

  function pptStatusFontSize(value, entry = null) {
    const text = pptStatusDisplay(value, entry);
    if (!text) return 20;
    if (text === '✓') return 32;
    const letters = (text.match(/\b[A-Z]+\./g) || []).length;
    if (letters >= 5) return 10;
    if (letters === 4) return 11;
    if (letters === 3) return 13;
    if (letters === 2) return 15;
    if (text.length <= 10) return 18;
    if (text.length <= 18) return 15;
    return 11;
  }

  function filtersForQuarter(q, filters = {}) {
    const latestId = filters.latestQuarterId || null;
    return {
      pastorType: filters.pastorType || 'All',
      statusFilter: filters.statusFilter || 'All',
      currentLatest: Boolean(latestId && q.id === latestId)
    };
  }

  async function buildPptx(quarterList, filters = {}) {
  const pptx = new PptxGenJS();
  // Explicit 16:9 PowerPoint canvas: 13.333 x 7.5 inches.
  pptx.defineLayout({ name: 'MISSION_16X9', width: 13.333, height: 7.5 });
  pptx.layout = 'MISSION_16X9';
  const SW = 13.333;
  const centerX = (w) => (SW - w) / 2;
  pptx.author = 'Mission Support Tracker';
  pptx.subject = 'Mission Support Records';
  pptx.title = 'Mission Support';
  pptx.company = 'Living Hope Baptist Church';
  pptx.lang = 'en-US';

  // __dirname can point at a bundled Next.js server chunk in production.
  // Check the deployment root first, then the source-relative path.
  const logoPath = [
    path.join(process.cwd(), 'public', 'images', 'logo.png'),
    path.resolve(__dirname, '../../public/images/logo.png'),
  ].find((candidate) => fs.existsSync(candidate));
  // Filter each quarter independently so a pastor's incomplete marks in one
  // quarter do not hide that quarter when their record exists in another.
  // The newest quarter always shows its full roster, even with Incomplete Only.
  quarterList = quarterList
    .map(q => ({
      ...q,
      entries: filterQuarterEntries(q, filtersForQuarter(q, filters))
        .map((entry, index) => ({ ...entry, number: index + 1 }))
    }))
    .filter(q => q.entries.length > 0);
  if (!quarterList.length) {
    const slide = pptx.addSlide();
    slide.background = { color: '26143F' };
    slide.addText(filters.statusFilter === 'Incomplete Only'
      ? 'NO INCOMPLETE SUPPORT RECORDS'
      : 'NO SUPPORT RECORDS', {
      x: 0.8, y: 2.65, w: 11.733, h: 0.8,
      fontSize: 28, bold: true, color: 'FFFFFF', align: 'center', valign: 'mid', fit: 'shrink'
    });
    return pptx;
  }
  const MARGIN = 0.85;

  quarterList.forEach(q => {
    const coverSlide = pptx.addSlide();
    coverSlide.background = { color: '2D1B4E' };

    if (logoPath) {
      coverSlide.addImage({ path: logoPath, x: centerX(1.98), y: 0.58, w: 1.98, h: 1.98 });
    }
    coverSlide.addText('LIVING HOPE BAPTIST CHURCH', {
      x: 0, y: 2.72, w: SW, h: 0.42,
      fontSize: 18, bold: true, color: 'DDD6FE', align: 'center', valign: 'mid',
      fit: 'shrink'
    });
    coverSlide.addText('Managok, Malaybalay City', {
      x: 0, y: 3.12, w: SW, h: 0.32,
      fontSize: 13, color: 'A78BFA', align: 'center', valign: 'mid'
    });
    coverSlide.addText(q.title || `${q.year} MISSION SUPPORT ${q.quarterName.toUpperCase()}`, {
      x: 0, y: 4.05, w: SW, h: 0.85,
      fontSize: 31, bold: true, color: 'FFFFFF', align: 'center', valign: 'mid',
      breakLine: false, fit: 'shrink', margin: 0.02
    });

    const entries = q.entries;
    const months = q.months || ['Month 1', 'Month 2', 'Month 3'];
    const chunkSize = 3;

    for (let i = 0; i < entries.length; i += chunkSize) {
      const chunk = entries.slice(i, i + chunkSize);
      const slide = pptx.addSlide();
      slide.background = { color: '26143F' };

      slide.addText(q.title || `${q.year} MISSION SUPPORT ${q.quarterName.toUpperCase()}`, {
        x: 0.60, y: 0.35, w: 12.133, h: 0.72,
        fontSize: 29, bold: true, color: 'FFFFFF', align: 'center', valign: 'mid',
        fit: 'shrink', margin: 0.02
      });

      const tableData = [[
        { text: 'PASTOR/ MISSIONARY', options: { bold: true, fill: { color: '4C1D95' }, color: 'FFFFFF', align: 'center', valign: 'middle', fontSize: 17, fit: 'shrink' } },
        ...months.slice(0, 3).map((m, idx) => ({ text: (m || `MONTH ${idx + 1}`).toUpperCase(), options: { bold: true, fill: { color: '4C1D95' }, color: 'FFFFFF', align: 'center', valign: 'middle', fontSize: 17, fit: 'shrink' } }))
      ]];
      while (tableData[0].length < 4) tableData[0].push({ text: `MONTH ${tableData[0].length}`, options: { bold: true, fill: { color: '4C1D95' }, color: 'FFFFFF', align: 'center', valign: 'middle', fontSize: 17 } });

      chunk.forEach(p => {
        const rowBg = '26143F';
        const nameLabel = `${p.number ? p.number + '. ' : ''}${p.name}`;
        const vals = [p.m1, p.m2, p.m3];
        tableData.push([
          { text: nameLabel, options: { fontSize: 36, color: 'FFFFFF', fill: { color: rowBg }, bold: true, align: 'left', valign: 'middle', fit: 'shrink', margin: 0.08 } },
          ...vals.map(v => {
            const text = pptStatusDisplay(v, p);
            return { text, options: { fontSize: pptStatusFontSize(v, p), color: text ? '34D399' : 'FFFFFF', align: 'center', valign: 'middle', fill: { color: rowBg }, bold: true, fit: 'shrink', margin: 0.03 } };
          })
        ]);
      });
      while (tableData.length < 4) {
        tableData.push([
          { text: '', options: { fill: { color: '26143F' } } },
          { text: '', options: { fill: { color: '26143F' } } },
          { text: '', options: { fill: { color: '26143F' } } },
          { text: '', options: { fill: { color: '26143F' } } }
        ]);
      }

      slide.addTable(tableData, {
        x: centerX(12.133), y: 1.72, w: 12.133,
        colW: [5.02, 2.371, 2.371, 2.371],
        rowH: [0.78, 1.42, 1.42, 1.42],
        border: { pt: 1.5, color: '7C3AED' },
        margin: 0.04,
        autoFit: false
      });
    }
  });
  return pptx;
}

  async function sendPptxDownload(res, pptx, filename) {
    const buffer = await pptx.write({ outputType: 'STREAM', compression: true });
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
      throw new Error('PowerPoint generation returned an invalid file.');
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    return res.end(buffer);
  }

  return { buildPptx, sendPptxDownload };
}

module.exports = { createPptxService };
