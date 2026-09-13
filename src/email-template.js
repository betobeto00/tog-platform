/**
 * Shared HTML email template for OmniMargen.
 * Wraps content with branded header (logo) and footer (legal links, unsubscribe).
 */

const SITE_URL = (process.env.SITE_URL || 'https://omnimargen.site').replace(/\/+$/, '')

const FOOTER_LINKS = {
  privacidad: `${SITE_URL}/privacidad`,
  licencia: `${SITE_URL}/licencia`,
  terminos: `${SITE_URL}/terminos`,
}

/**
 * Wraps inner HTML content with branded header and footer.
 * @param {string} title - Email subject / heading
 * @param {string} innerHtml - The main content HTML
 * @param {object} [opts]
 * @param {string} [opts.unsubscribeUrl] - Unsubscribe link (if applicable)
 * @param {string} [opts.preheader] - Preview text shown in some email clients
 */
export function wrapEmail(title, innerHtml, opts = {}) {
  const preheader = opts.preheader || ''
  const unsubscribe = opts.unsubscribeUrl || ''

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  ${preheader ? `<meta name="description" content="${escapeHtml(preheader)}">` : ''}
</head>
<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7">
    <tr>
      <td align="center" style="padding:32px 16px">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">

          <!-- HEADER -->
          <tr>
            <td style="padding:24px 32px;background-color:#ffffff;border-radius:12px 12px 0 0;text-align:center;border-bottom:1px solid #e5e7eb">
              <a href="${SITE_URL}" style="text-decoration:none">
                <img src="${SITE_URL}/logo.jpg" alt="OmniMargen" width="160" style="display:block;margin:0 auto 8px;border:0;height:auto">
              </a>
              <p style="margin:0;color:#1a1a2e;font-size:13px">Sistema de gestión empresarial</p>
            </td>
          </tr>

          <!-- BODY -->
          <tr>
            <td style="padding:32px;background-color:#ffffff;border-radius:0 0 0 0">
              ${innerHtml}
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td style="padding:24px 32px;background-color:#f9fafb;border-radius:0 0 12px 12px;border-top:1px solid #e5e7eb">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding-bottom:16px">
                    <a href="${SITE_URL}" style="text-decoration:none">
                      <img src="${SITE_URL}/logo.jpg" alt="OmniMargen" width="100" style="display:block;margin:0 auto;border:0;height:auto;opacity:0.7">
                    </a>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding-bottom:12px">
                    <a href="${FOOTER_LINKS.privacidad}" style="color:#6b7280;font-size:12px;text-decoration:none;margin:0 8px">Política de Privacidad</a>
                    <span style="color:#d1d5db">·</span>
                    <a href="${FOOTER_LINKS.licencia}" style="color:#6b7280;font-size:12px;text-decoration:none;margin:0 8px">Licencia de Uso</a>
                    <span style="color:#d1d5db">·</span>
                    <a href="${FOOTER_LINKS.terminos}" style="color:#6b7280;font-size:12px;text-decoration:none;margin:0 8px">Términos y Condiciones</a>
                  </td>
                </tr>
                ${unsubscribe ? `
                <tr>
                  <td align="center" style="padding-bottom:12px">
                    <a href="${unsubscribe}" style="color:#9ca3af;font-size:11px;text-decoration:underline">Darme de baja de estos correos</a>
                  </td>
                </tr>` : ''}
                <tr>
                  <td align="center">
                    <p style="margin:0;color:#9ca3af;font-size:11px;line-height:1.5">
                      OmniMargen · omnimargen.site<br>
                      Si no creaste esta cuenta, puedes ignorar este mensaje.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

export function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
