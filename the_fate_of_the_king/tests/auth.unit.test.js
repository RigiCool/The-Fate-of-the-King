const auth = require('../auth');
const jwt = require('jsonwebtoken');

describe('auth module', () => {
  test('hash and verify password', async () => {
    const hash = await auth.hashPassword('secret');
    expect(typeof hash).toBe('string');
    const ok = await auth.verifyPassword('secret', hash);
    expect(ok).toBe(true);
    const fail = await auth.verifyPassword('wrong', hash);
    expect(fail).toBe(false);
  });

  test('signToken generate valid jwt', () => {
    const token = auth.signToken({ id: 1, email: 'a@b', role: 'user' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret_change_me');
    expect(decoded.sub).toBe(1);
  });

  test('authRequired reject missed token', () => {
    const req = { headers: {} };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    const next = jest.fn();
    auth.authRequired(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('adminRequired verify role', () => {
    const req = { user: { role: 'user' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    auth.adminRequired(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();

    req.user.role = 'admin';
    auth.adminRequired(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  describe('auth required additional branch coverage testing', () => {
    test('authRequired reject invalid and expired token', () => {
      const invalidToken = jwt.sign({ sub: 1, email: 'a@b', role: 'user' }, 'wrong_secret', { expiresIn: '1s' });
      const req = { headers: { authorization: 'Bearer ' + invalidToken } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();
      auth.authRequired(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
      expect(next).not.toHaveBeenCalled();
    });

    test('authRequired accept valid token', () => {
      const token = auth.signToken({ id: 2, email: 'b@c', role: 'user' });
      const req = { headers: { authorization: 'Bearer ' + token } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();
      auth.authRequired(req, res, next);
      expect(req.user).toMatchObject({ id: 2, email: 'b@c', role: 'user' });
      expect(next).toHaveBeenCalled();
    });
  });
});
