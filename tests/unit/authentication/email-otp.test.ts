import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock AWS SES
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-ses', () => ({
  SESClient: jest.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  SendEmailCommand: jest.fn().mockImplementation((params) => params),
}));

// Set required env vars before importing the module
process.env.AWS_ACCESS_KEY_ID = 'test-key';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
process.env.AWS_REGION = 'us-east-1';
process.env.SES_FROM_EMAIL = 'noreply@wxyc.org';

// Import after mocks and env setup
import { sendOTPEmail, buildOTPEmailHtml } from '../../../shared/authentication/src/email';

describe('Email OTP', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
  });

  describe('buildOTPEmailHtml', () => {
    it('should render the OTP code in the email', () => {
      const html = buildOTPEmailHtml({
        title: 'Your WXYC login code',
        intro: 'Use this code to sign in to your account.',
        otp: '123456',
      });

      expect(html).toContain('123456');
      expect(html).toContain('Your WXYC login code');
      expect(html).toContain('Use this code to sign in to your account.');
    });

    it('should include WXYC branding', () => {
      const html = buildOTPEmailHtml({
        title: 'Test',
        intro: 'Test',
        otp: '000000',
      });

      expect(html).toContain('wxyc.org');
      expect(html).toContain('alt="WXYC"');
    });

    it('should use monospace font for the OTP display', () => {
      const html = buildOTPEmailHtml({
        title: 'Test',
        intro: 'Test',
        otp: '654321',
      });

      expect(html).toContain('font-family:monospace');
      expect(html).toContain('letter-spacing:8px');
    });

    it('should render custom footer when provided', () => {
      const html = buildOTPEmailHtml({
        title: 'Test',
        intro: 'Test',
        otp: '000000',
        footer: 'Custom footer text',
      });

      expect(html).toContain('Custom footer text');
    });

    it('should render default footer when none provided', () => {
      const html = buildOTPEmailHtml({
        title: 'Test',
        intro: 'Test',
        otp: '000000',
      });

      expect(html).toContain('If you did not request this email');
    });
  });

  describe('sendOTPEmail', () => {
    it.each([
      {
        type: 'sign-in' as const,
        expectedSubject: 'Your WXYC login code',
        expectedIntro: 'Use this code to sign in to your account.',
      },
      {
        type: 'email-verification' as const,
        expectedSubject: 'Your WXYC verification code',
        expectedIntro: 'Use this code to verify your email address.',
      },
      {
        type: 'forget-password' as const,
        expectedSubject: 'Your WXYC password reset code',
        expectedIntro: 'Use this code to reset your password.',
      },
    ])('should send $type OTP email with correct subject and content', async ({ type, expectedSubject, expectedIntro }) => {
      await sendOTPEmail({ to: 'dj@wxyc.org', otp: '123456', type });

      expect(mockSend).toHaveBeenCalledTimes(1);

      const command = mockSend.mock.calls[0][0] as any;
      expect(command.Source).toBe('noreply@wxyc.org');
      expect(command.Destination.ToAddresses).toEqual(['dj@wxyc.org']);
      expect(command.Message.Subject.Data).toBe(expectedSubject);
      expect(command.Message.Body.Text.Data).toContain('123456');
      expect(command.Message.Body.Text.Data).toContain('expires in 5 minutes');
      expect(command.Message.Body.Html.Data).toContain('123456');
      expect(command.Message.Body.Html.Data).toContain(expectedIntro);
    });

    it('should throw if SES_FROM_EMAIL is not set', async () => {
      const originalFrom = process.env.SES_FROM_EMAIL;
      delete process.env.SES_FROM_EMAIL;

      await expect(sendOTPEmail({ to: 'dj@wxyc.org', otp: '123456', type: 'sign-in' })).rejects.toThrow('SES_FROM_EMAIL');

      process.env.SES_FROM_EMAIL = originalFrom;
    });
  });
});
