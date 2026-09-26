require('dotenv').config();

async function testSMS() {
  const phoneNumber = '639XXXXXXXXX'; // Replace only for local testing; do not commit a real phone number

  const response = await fetch(
    'https://www.iprogsms.com/api/v1/sms_messages',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        api_token: process.env.IPROG_SMS_API_TOKEN,
        phone_number: phoneNumber,
        message: 'Test SMS from Living Hope System. IPROG SMS integration is working.'
      })
    }
  );

  const data = await response.json();

  console.log('HTTP Status:', response.status);
  console.log('IPROG Response:', data);
}

testSMS().catch(error => {
  console.error('SMS Test Error:', error);
});