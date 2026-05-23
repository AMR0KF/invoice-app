const { buildPDFBuffer, safeFilename } = require("../generate_pdf");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    const data = req.body || {};
    data.template = "meridian_v2";
    const invoiceNumber = data.invoice_number || "INV-001";
    const pdf = await buildPDFBuffer(data);
    const filename = `${safeFilename(invoiceNumber)}.pdf`;

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("X-Invoice-Filename", filename);
    res.end(Buffer.from(pdf));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: err && err.message ? err.message : "PDF generation failed" }));
  }
};
