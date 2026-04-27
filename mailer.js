const nodemailer = require('nodemailer')

const transporter = nodemailer.createTransport({
  service: 'gmail',
  port: 587,
  secure: false,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS
  }
})

const recipients = process.env.MAIL_TO || 'paul.oen55@gmail.com'

async function sendNotification(summary) {
  await transporter.sendMail({
    from: `Sloaney Pony <${process.env.MAIL_USER}>`,
    to: recipients,
    subject: `Sloaney Pony — ${summary}`,
    text: `${summary}\n\nThis notification was sent by the Sloaney Pony scheduler.`
  })
}

module.exports = { sendNotification }
