# Mission Support Management System & PowerPoint Generator

Usa ka moderno ug sayon gamiton nga CRUD Web Application para sa pagdumala sa Mission Support sa mga Pastor ug Missionary, nga adunay automatic PowerPoint (.pptx) presentation generator.

## Mga Feature:
1. **Kompleto nga Reference Data**: Naka-load daan ang tanang 14 ka quarters (2022 Q4 hangtod 2026 Q3) gikan sa orihinal nga 396-slide PowerPoint file.
2. **Full CRUD**:
   - **Create**: Pagdugang og bag-ong Pastor/Missionary o paghimo og bag-ong Quarter.
   - **Read**: Live search, filter by Year & Quarter, statistics ug support completion percentage.
   - **Update**: 1-click monthly status toggling (check/uncheck), bulk updates, ug edit details.
   - **Delete**: Pagtangtang og record nga naay confirmation.
3. **Downloadable PowerPoint (.pptx)**:
   - I-click lang ang " Download PPT\ aron makakuha og bag-ong .pptx file nga gi-format tag-3 ka pastor matag slide aron dako ug klaro para sa church projector!
4. **Live Projector Mode**:
 - Pwede i-preview o i-presentar ang mga slides diretso sa browser gamit ang \Present Slides\ button.
5. **Purple Theme UI**:
 - Nindot ug elegante nga purple color palette (#2D1B4E, #4C1D95, #7C3AED).

## Unsaon Pagpadagan:
- I-double click lang ang \start_app.bat\, o ipadagan kini sa terminal:
 \\\ash
 node server.js
 \\\
- Ablihi ang browser sa: [http://localhost:3000](http://localhost:3000)


## Latest updates

- Dynamic A/B/C/D/E support totals: each letter is one support slot per month. For example, A+B across three months is 6/6; A+B+C is 9/9; A+B+C+D is 12/12; A+B+C+D+E is 15/15.
- New Local / Foreign / Unassigned pastor classification and filters. The selected type is also applied to PPT exports and presentations.
- Mission Report Builder: select multiple quarters, choose pastor type and status, view the selected report in the browser, or download one combined PPTX.
- Incomplete-only reporting filters completed pastors from older/completed quarters. The latest/current quarter is always shown in full so the report can show both complete and incomplete pastors.
- The All year filter is functional and displays every available quarter; the same selection can be presented or downloaded.
- Deleted pastors now go to a Recycle Bin. Restore returns the full record and support history to its original quarter/order; permanent deletion requires confirmation.
