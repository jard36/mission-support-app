require('dotenv').config();

const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendTestEmail() {
  const { data, error } = await resend.emails.send({
    from: 'onboarding@resend.dev',
    to: ['delivered@resend.dev'],
    subject: 'Living Hope Email Test',
    html: `
      <h2>Living Hope Email Test</h2>
      <p>This is a test email from the Living Hope notification setup.</p>
      <p>If you can see this, Resend is working.</p>
    `
  });

  if (error) {
    console.error('Email failed:');
    console.error(error);
    return;
  }

  console.log('Email sent successfully!');
  console.log(data);
}

sendTestEmail();