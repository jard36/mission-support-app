const express = require('express');

function createReportRouter({
  readDB,
  normalizeDB,
  filterQuarterForUser,
  buildPptx,
  sendPptxDownload,
  sendInternalError
}) {
  const router = express.Router();

  router.get('/export/pptx/:quarterId', async (req, res) => {
    try {
      const db = normalizeDB(await readDB());
      const quarter = filterQuarterForUser(
        db.quarters.find(item => item.id === req.params.quarterId),
        req.user
      );
      if (!quarter) return res.status(404).json({ error: 'Quarter not found' });

      const latestQuarterId = db.quarters.length ? db.quarters[db.quarters.length - 1].id : null;
      const pptx = await buildPptx([quarter], {
        pastorType: req.query.pastorType || 'All',
        statusFilter: req.query.statusFilter || 'All',
        latestQuarterId
      });
      await sendPptxDownload(res, pptx, `Mission_Support_${quarter.id}.pptx`);
    } catch (error) {
      sendInternalError(res, error, 'Single-quarter PPTX export error:');
    }
  });

  router.get('/export/pptx-report', async (req, res) => {
    try {
      const db = normalizeDB(await readDB());
      const ids = String(req.query.quarterIds || '').split(',').map(id => id.trim()).filter(Boolean);
      const selectedQuarters = ids.length ? db.quarters.filter(quarter => ids.includes(quarter.id)) : db.quarters;
      if (!selectedQuarters.length) return res.status(400).json({ error: 'No quarters selected for the report' });
      const quarters = req.user?.role === 'supporter'
        ? selectedQuarters.map(quarter => filterQuarterForUser(quarter, req.user))
        : selectedQuarters;

      const latestQuarterId = db.quarters.length ? db.quarters[db.quarters.length - 1].id : null;
      const pptx = await buildPptx(quarters, {
        pastorType: req.query.pastorType || 'All',
        statusFilter: req.query.statusFilter || 'All',
        latestQuarterId
      });
      const label = ids.length === 1 ? ids[0] : `${selectedQuarters[0].year}-${selectedQuarters[selectedQuarters.length - 1].year}`;
      await sendPptxDownload(res, pptx, `Mission_Support_Report_${label}.pptx`);
    } catch (error) {
      sendInternalError(res, error, 'Mission report PPTX export error:');
    }
  });

  router.get('/export/pptx-all', async (req, res) => {
    try {
      const db = normalizeDB(await readDB());
      const latestQuarterId = db.quarters.length ? db.quarters[db.quarters.length - 1].id : null;
      const quarters = req.user?.role === 'supporter'
        ? db.quarters.map(quarter => filterQuarterForUser(quarter, req.user))
        : db.quarters;
      const pptx = await buildPptx(quarters, {
        pastorType: req.query.pastorType || 'All',
        statusFilter: req.query.statusFilter || 'All',
        latestQuarterId
      });
      await sendPptxDownload(res, pptx, 'Mission_Support_All_Quarters.pptx');
    } catch (error) {
      sendInternalError(res, error, 'All-quarters PPTX export error:');
    }
  });

  return router;
}

module.exports = { createReportRouter };
