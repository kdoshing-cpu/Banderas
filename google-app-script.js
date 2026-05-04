/**
 * CODIGO PARA GOOGLE APPS SCRIPT (Code.gs)
 * 
 * Este script permite servir una página HTML y gestionar el guardado de datos
 * en una Google Sheet (Hoja de Cálculo).
 */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
      .setTitle('Flag Quest - Google App Script')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Función para guardar datos desde el cliente
 * @param {Object} data - Objeto con name, score, time
 */
function saveDataToSheet(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Ranking');
  
  if (!sheet) {
    sheet = ss.insertSheet('Ranking');
    sheet.appendRow(['Usuario', 'Puntos', 'Tiempo Total', 'Fecha']);
  }
  
  sheet.appendRow([
    data.name, 
    data.score, 
    data.time, 
    new Date()
  ]);
  
  return "Datos guardados correctamente en Google Sheets";
}

/**
 * ARCHIVO INDEX.HTML (Para Google App Script)
 * 
 * <!DOCTYPE html>
 * <html>
 *   <head>
 *     <base target="_top">
 *     <style>
 *       body { font-family: sans-serif; text-align: center; padding: 20px; }
 *       .btn { background: #38bdf8; color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; }
 *     </style>
 *   </head>
 *   <body>
 *     <h1>Flag Quest GAS</h1>
 *     <div id="status"></div>
 *     <button class="btn" onclick="save()">Guardar en Google Sheet</button>
 *     
 *     <script>
 *       function save() {
 *         const data = { name: "Usuario GAS", score: 10, time: "05:00" };
 *         google.script.run
 *           .withSuccessHandler(msg => document.getElementById('status').innerText = msg)
 *           .saveDataToSheet(data);
 *       }
 *     </script>
 *   </body>
 * </html>
 */
