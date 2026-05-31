#!/usr/bin/env ruby
# encoding: utf-8
Encoding.default_external = Encoding::UTF_8
Encoding.default_internal = Encoding::UTF_8
#
# פרישה פרימיום – שרת הצטרפות לקוחות
# Uses only Ruby built-in libraries (WEBrick + net/smtp)
# Usage:  ruby server.rb

require 'webrick'
require 'json'
# net/smtp replaced by SendGrid HTTP API
require 'net/http'
require 'openssl'
require 'base64'
require 'uri'

# ── Config ────────────────────────────────────────────────
CONFIG_FILE = File.join(__dir__, 'config.json')
CFG = File.exist?(CONFIG_FILE) ? JSON.parse(File.read(CONFIG_FILE, encoding: 'utf-8')) : {}

def to_utf8(str)
  str.to_s.encode('UTF-8', invalid: :replace, undef: :replace)
end

COMPANY       = to_utf8(ENV['COMPANY_NAME']  || CFG.fetch('company_name',      'פרישה פרימיום'))
ANTHROPIC_KEY = to_utf8(ENV['ANTHROPIC_KEY'] || CFG.fetch('anthropic_api_key', ''))
ADMIN         = to_utf8(ENV['ADMIN_EMAIL']   || CFG.fetch('admin_email',        ''))
SMTP_USER     = to_utf8(ENV['SMTP_USER']       || CFG.fetch('smtp_user',       ''))
SENDGRID_KEY  = to_utf8(ENV['SENDGRID_KEY']   || CFG.fetch('sendgrid_key',     ''))
PORT          = (ENV['PORT']                 || CFG.fetch('port',               3000)).to_i

# ── ID OCR via Claude Vision ──────────────────────────────
def call_claude_vision(image_b64)
  return { 'success' => false, 'message' => 'מפתח Anthropic API לא הוגדר ב-config.json' } if ANTHROPIC_KEY.empty?

  uri  = URI('https://api.anthropic.com/v1/messages')
  http = Net::HTTP.new(uri.host, uri.port)
  http.use_ssl      = true
  http.open_timeout = 15
  http.read_timeout = 30

  prompt = <<~PROMPT
    This is an image of an Israeli ID card (תעודת זהות), possibly including the appendix (ספח).
    Extract the following fields and return ONLY a valid JSON object — no other text before or after:
    {"firstName":"","lastName":"","idNumber":"","birthDate":"YYYY-MM-DD","idIssueDate":"YYYY-MM-DD","address":""}
    Rules:
    - firstName, lastName: in Hebrew exactly as printed on the card
    - idNumber: exactly 9 digits
    - birthDate, idIssueDate: YYYY-MM-DD format
    - address: full address from the ספח (appendix) if visible
    - Use empty string "" for any field that is unclear or not visible
    Return ONLY the JSON object, nothing else.
  PROMPT

  payload = {
    model: 'claude-opus-4-6',
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image_b64 } },
        { type: 'text',  text: prompt }
      ]
    }]
  }

  req = Net::HTTP::Post.new(uri.path)
  req['x-api-key']         = ANTHROPIC_KEY
  req['anthropic-version'] = '2023-06-01'
  req['content-type']      = 'application/json'
  req.body = JSON.generate(payload)

  resp = http.request(req)
  data = JSON.parse(resp.body)

  if resp.code == '200'
    text     = data.dig('content', 0, 'text').to_s.strip
    json_str = text.match(/\{.*\}/m)&.[](0)
    if json_str
      { 'success' => true, 'data' => JSON.parse(json_str) }
    else
      { 'success' => false, 'message' => 'לא ניתן לפרש את התשובה' }
    end
  else
    err = data.dig('error', 'message') || resp.code
    { 'success' => false, 'message' => "שגיאת API: #{err}" }
  end
rescue => e
  { 'success' => false, 'message' => "שגיאה: #{e.message}" }
end

# ── Mailer via SendGrid API ───────────────────────────────
def sendgrid_send(to:, subject:, html:, pdf_b64: nil, pdf_name: nil)
  uri  = URI('https://api.sendgrid.com/v3/mail/send')
  http = Net::HTTP.new(uri.host, uri.port)
  http.use_ssl     = true
  http.read_timeout = 30

  body = {
    personalizations: [{ to: [{ email: to }] }],
    from:    { email: SMTP_USER, name: COMPANY },
    subject: subject,
    content: [{ type: 'text/html', value: html }]
  }

  if pdf_b64 && pdf_name
    body[:attachments] = [{
      content:     pdf_b64,
      filename:    pdf_name,
      type:        'application/pdf',
      disposition: 'attachment'
    }]
  end

  req = Net::HTTP::Post.new(uri.path)
  req['Authorization'] = "Bearer #{SENDGRID_KEY}"
  req['Content-Type']  = 'application/json'
  req.body = JSON.generate(body)

  http.request(req)
end

def send_emails(client, pdf_bytes)
  first = client['firstName'] || ''
  last  = client['lastName']  || ''
  email = client['email']     || ''

  pdf_b64  = Base64.strict_encode64(pdf_bytes)
  pdf_name = "הצטרפות-#{first}-#{last}.pdf"

  client_html = <<~HTML
    <div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:linear-gradient(135deg,#1a1a2e,#0f3460);color:white;padding:30px;text-align:center;border-radius:8px 8px 0 0;">
        <h1 style="margin:0;font-size:24px;">#{COMPANY}</h1>
        <p style="margin:8px 0 0;opacity:.8;">אישור הצטרפות</p>
      </div>
      <div style="background:#fff;padding:30px;border:1px solid #eee;border-radius:0 0 8px 8px;">
        <p style="font-size:16px;">שלום <strong>#{first} #{last}</strong>,</p>
        <p>תודה על הצטרפותך ל#{COMPANY}! אנחנו שמחים לקבל אותך.</p>
        <p>טופס ההצטרפות החתום מצורף לאימייל זה כקובץ PDF.</p>
        <div style="background:#f0f7ff;border-right:4px solid #0f3460;padding:15px;margin:20px 0;border-radius:4px;">
          <p style="margin:0;font-weight:bold;">מה קורה עכשיו?</p>
          <p style="margin:8px 0 0;">אנו פונים כעת לגופים הרלוונטיים (קרנות פנסיה, קופות גמל ועוד) לקבלת המידע המלא אודות חסכונותיך ונכסיך. נחזור אליך עם תמונה מלאה בהקדם האפשרי.</p>
        </div>
        <p>בברכה,<br><strong>צוות #{COMPANY}</strong></p>
      </div>
    </div>
  HTML

  rows = [
    ['שם מלא',     "#{first} #{last}"],
    ['מספר ת.ז',   client['idNumber']    || ''],
    ['טלפון',      client['phone']       || ''],
    ['אימייל',     email],
    ['תאריך לידה', client['birthDate']   || ''],
    ['הנפקת ת.ז',  client['idIssueDate'] || ''],
  ]
  rows_html = rows.each_with_index.map do |(label, value), i|
    bg = i.even? ? '#f8f9fa' : 'white'
    "<tr><td style='padding:8px;background:#{bg};font-weight:bold;width:40%;'>#{label}:</td><td style='padding:8px;'>#{value}</td></tr>"
  end.join

  admin_html = <<~HTML
    <div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#1a1a2e;color:white;padding:20px;text-align:center;border-radius:8px 8px 0 0;">
        <h2 style="margin:0;">לקוח חדש הצטרף!</h2>
      </div>
      <div style="background:#fff;padding:25px;border:1px solid #eee;border-radius:0 0 8px 8px;">
        <table style="width:100%;border-collapse:collapse;">#{rows_html}</table>
        <p style="margin-top:20px;color:#666;font-size:13px;">טופס ההצטרפות החתום מצורף.</p>
      </div>
    </div>
  HTML

  sendgrid_send(to: email,  subject: "אישור הצטרפות – #{COMPANY}", html: client_html, pdf_b64: pdf_b64, pdf_name: pdf_name) if email && !email.empty?
  sendgrid_send(to: ADMIN,  subject: "לקוח חדש: #{first} #{last}", html: admin_html,  pdf_b64: pdf_b64, pdf_name: pdf_name) if ADMIN && !ADMIN.empty?
end

# ── HTTP Servlet ──────────────────────────────────────────
class OnboardingServlet < WEBrick::HTTPServlet::AbstractServlet
  def do_POST(req, res)
    case req.path

    when '/api/extract-id'
      STDERR.puts "\n[extract-id] קיבלתי בקשה"
      begin
        payload = JSON.parse(req.body)
      rescue JSON::ParserError => e
        STDERR.puts "[extract-id] שגיאת JSON: #{e.message}"
        json_error(res, 400, 'JSON לא תקין'); return
      end
      image_b64 = payload['imageBase64'].to_s
      STDERR.puts "[extract-id] גודל תמונה (base64): #{image_b64.length} תווים"
      if image_b64.empty?
        STDERR.puts "[extract-id] תמונה חסרה"
        json_error(res, 400, 'תמונה חסרה'); return
      end
      STDERR.puts "[extract-id] שולח ל-Claude API..."
      result = call_claude_vision(image_b64)
      STDERR.puts "[extract-id] תשובה: #{result.inspect}"
      result['success'] ? json_ok(res, result) : json_error(res, 500, result['message'])

    when '/api/submit'
      begin
        payload = JSON.parse(req.body)
      rescue JSON::ParserError
        json_error(res, 400, 'JSON לא תקין'); return
      end
      client  = payload['clientData'] || {}
      pdf_b64 = payload['pdfBase64']  || ''
      if client['firstName'].to_s.empty?
        json_error(res, 400, 'נתונים חסרים'); return
      end
      if pdf_b64.empty?
        json_error(res, 400, 'קובץ PDF חסר'); return
      end
      begin
        pdf_bytes = Base64.decode64(pdf_b64)
        send_emails(client, pdf_bytes)
        json_ok(res, { success: true, message: 'המסמכים נשלחו בהצלחה!' })
      rescue Net::SMTPAuthenticationError => e
        STDERR.puts "SMTP Auth Error: #{e}"
        json_error(res, 500, 'שגיאת אימות – בדוק smtp_user ו-smtp_password ב-config.json')
      rescue => e
        STDERR.puts "Error: #{e}\n#{e.backtrace.first(3).join("\n")}"
        json_error(res, 500, "שגיאה פנימית: #{e.message}")
      end

    else
      res.status = 404
    end
  end

  private

  def json_ok(res, data)
    body = JSON.generate(data)
    res.status = 200
    res['Content-Type']   = 'application/json; charset=utf-8'
    res['Access-Control-Allow-Origin'] = '*'
    res.body = body
  end

  def json_error(res, code, msg)
    body = JSON.generate({ success: false, message: msg })
    res.status = code
    res['Content-Type']   = 'application/json; charset=utf-8'
    res['Access-Control-Allow-Origin'] = '*'
    res.body = body
  end
end

# ── Start ─────────────────────────────────────────────────
public_dir = File.join(__dir__, 'public')

server = WEBrick::HTTPServer.new(
  Port:          PORT,
  DocumentRoot:  public_dir,
  AccessLog:     [],          # suppress access log
  Logger:        WEBrick::Log.new('/dev/null'),
)

server.mount('/api', OnboardingServlet)

puts ""
puts "=" * 52
puts "  Server: #{COMPANY.encode('UTF-8', invalid: :replace, undef: :replace)}"
puts "=" * 52
puts "  Port: #{PORT}"
puts "  Admin: #{ADMIN}"
puts "  SMTP: #{SMTP_HOST}:#{SMTP_PORT}"
puts ""

trap('INT') do
  puts "\n\n  👋 השרת נעצר."
  server.shutdown
end

server.start
