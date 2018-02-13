const supertest = require('supertest');
const Koa = require('koa');
const {
  createDefaultEnvironment,
  destroyDefaultEnvironment
} = require('@cardstack/test-support/env');
const JSONAPIFactory = require('@cardstack/test-support/jsonapi-factory');
const logger = require('@cardstack/logger');

describe('authentication/middleware', function() {

  let request, env, auth, quint, arthur;

  async function setup() {
    let factory = new JSONAPIFactory();

    quint = factory.addResource('test-users').withAttributes({
      email: 'quint@example.com',
      fullName: "Quint Faulkner"
    });

    arthur = factory.addResource('test-users', 'a-1').withAttributes({
      email: 'arthur@example.com',
      fullName: "Arthur Faulkner"
    });

    factory.addResource('data-sources', 'echo').withAttributes({
      sourceType: 'stub-authenticators::echo'
    });

    factory.addResource('data-sources', 'returns-nothing').withAttributes({
      sourceType: 'stub-authenticators::returns-nothing'
    });

    factory.addResource('data-sources', 'by-email').withAttributes({
      sourceType: 'stub-authenticators::by-email',
      params: {
        hidden: true
      }
    });

    factory.addResource('data-sources', 'always-invalid').withAttributes({
      sourceType: 'stub-authenticators::always-invalid'
    });

    factory.addResource('data-sources', 'config-echo-quint').withAttributes({
      sourceType: 'stub-authenticators::config-echo',
      params: {
        data: { id: quint.id, type: 'test-users' }
      }
    });

    factory.addResource('data-sources', 'config-echo-arthur').withAttributes({
      sourceType: 'stub-authenticators::config-echo',
      params: {
        data: { id: arthur.id, type: 'test-users' }
      }
    });

    factory.addResource('data-sources', 'id-rewriter').withAttributes({
      sourceType: 'stub-authenticators::echo',
      userTemplate: '{ "data": { "id": "{{upstreamId}}", "type": "test-users" }}'
    });

    factory.addResource('data-sources', 'has-default-template').withAttributes({
      sourceType: 'stub-authenticators::has-default-template'
    });


    factory.addResource('data-sources', 'create-via-template').withAttributes({
      sourceType: 'stub-authenticators::echo',
      userTemplate: `{"data":{
        "id": "my-prefix-{{id}}",
        "type": "test-users",
        "attributes": {
          "full-name": "{{firstName}} {{lastName}}",
          "email": "{{email}}"
        }
      }}`,
      mayCreateUser: true
    });

    factory.addResource('data-sources', 'create-via-template-no-id').withAttributes({
      sourceType: 'stub-authenticators::echo',
      userTemplate: `{"data":{
        "type": "test-users",
        "attributes": {
          "full-name": "{{firstName}} {{lastName}}",
          "email": "{{email}}"
        }
      }}`,
      mayCreateUser: true
    });


    factory.addResource('data-sources', 'update-user').withAttributes({
      sourceType: 'stub-authenticators::echo',
      mayUpdateUser: true
    });

    factory.addResource('content-types', 'test-users').withRelated('fields', [
      factory.addResource('fields', 'full-name').withAttributes({
        fieldType: '@cardstack/core-types::string'
      }),
      factory.addResource('fields', 'email').withAttributes({
        fieldType: '@cardstack/core-types::string'
      })
    ]);


    env = await createDefaultEnvironment(`${__dirname}/stub-authenticators`, factory.getModels());
    let app = new Koa();
    app.use(env.lookup('hub:middleware-stack').middleware());
    app.use(async function(ctxt) {
      ctxt.set('Content-Type', 'application/json');
      ctxt.body = {};
      let session = ctxt.state.cardstackSession;
      if (session) {
        ctxt.body.userId = session.id;
        try {
          ctxt.body.user = await session.loadUser();
        } catch (err) {
          ctxt.body.user = { error: err };
        }
      }
    });
    request = supertest(app.callback());
    auth = env.lookup('plugin-middleware:' + require.resolve('../cardstack/middleware'));
  }

  async function teardown() {
    await destroyDefaultEnvironment(env);
  }

  describe('(read)', function() {

    before(setup);
    after(teardown);

    it('leaves user blank by default', async function() {
      let response = await request.get('/');
      expect(response.body).deep.equals({});
    });

    it('ignores a bogus token', async function() {
      await logger.expectWarn(/Ignoring invalid token/, async () => {
        let response = await request.get('/').set('authorization', `Bearer xxx--yyy--zzz`);
        expect(response.body).deep.equals({});
      });
    });

    it('ignores expired token', async function() {
      let { token } = await auth.createToken({ id: 42, type: 'test-users' }, -30);
      let response = await request.get('/').set('authorization', `Bearer ${token}`);
      expect(response.body).deep.equals({});
    });

    it('issues a working token', async function() {
      let { token } = await auth.createToken({ id: env.user.data.id, type: 'test-users' }, 30);
      let response = await request.get('/').set('authorization', `Bearer ${token}`);
      expect(response.body).has.property('userId', env.user.data.id);
    });


    it('token comes with validity timestamp', async function() {
      let { validUntil } = await auth.createToken({ id: env.user.data.id, type: 'test-users' }, 30);
      expect(validUntil).is.a('number');
    });

    it('offers full user load within session', async function() {
      let { token } = await auth.createToken({ id: env.user.data.id, type: env.user.data.type }, 30);
      let response = await request.get('/').set('authorization', `Bearer ${token}`);
      expect(response.body.user).deep.equals(env.user);
    });

    describe('token endpoints', async function() {

      it('supports CORS preflight', async function() {
        let response = await request.options('/auth/echo');
        expect(response).hasStatus(200);
        expect(response.headers['access-control-allow-methods']).matches(/POST/);
      });

      it('supports CORS', async function() {
        let response = await request.post('/auth/echo').send({});
        expect(response.headers['access-control-allow-origin']).equals('*');
      });

      it('returns not found for missing module', async function() {
        await logger.expectWarn(/Did not locate authentication source "foo"/, async () => {
          let response = await request.post('/auth/foo').send({});
          expect(response).hasStatus(404);
        });
      });

      it('finds authenticator', async function() {
        let response = await request.post(`/auth/echo`).send({ data: {id : env.user.data.id, type: 'test-users' }});
        expect(response).hasStatus(200);
      });

      it('responds with token', async function() {
        let response = await request.post(`/auth/echo`).send({ data: { id: env.user.data.id, type: 'test-users' }});
        expect(response).hasStatus(200);
        expect(response.body.data.meta.token).is.a('string');
      });

      it('responds with validity timestamp', async function() {
        let response = await request.post(`/auth/echo`).send({ data: { id: env.user.data.id, type: 'test-users' }});
        expect(response).hasStatus(200);
        expect(response.body.data.meta.validUntil).is.a('number');
      });

      it('responds with a copy of the user record', async function() {
        let response = await request.post(`/auth/echo`).send({ data: { id: env.user.data.id, type: 'test-users' }});
        expect(response).hasStatus(200);
        let responseWithoutMeta = Object.assign({}, response.body);
        delete responseWithoutMeta.data.meta;
        expect(responseWithoutMeta).deep.equals(env.user);
      });

    });

    describe('token issuers', function() {

      it('can run with multiple configs', async function() {
        let response = await request.post(`/auth/config-echo-quint`).send({
          data: 'ignored'
        });
        expect(response).hasStatus(200);
        expect(response.body).has.deep.property('data.id', quint.id);

        response = await request.post(`/auth/config-echo-arthur`).send({
          user: 'ignored'
        });
        expect(response).hasStatus(200);
        expect(response.body).has.deep.property('data.id', arthur.id);
      });

      it('can approve via id', async function() {
        let response = await request.post(`/auth/echo`).send({
          data: { id: env.user.data.id, type: 'test-users' }
        });
        expect(response).hasStatus(200);
        expect(response.body).has.deep.property('data.meta.token');
        expect(response.body).has.deep.property('data.meta.validUntil');
        response = await request.get('/').set('authorization', `Bearer ${response.body.data.meta.token}`);
        expect(response).hasStatus(200);
        expect(response.body).has.property('userId', env.user.data.id);
        expect(response.body.user).deep.equals(env.user);
      });

      it('can throw', async function() {
        let response = await request.post(`/auth/always-invalid`).send({});
        expect(response).hasStatus(400);
        expect(response.body.errors).collectionContains({
          detail: "Your input is terrible and you should feel bad"
        });
      });

      it('can reject by returning no id', async function() {
        let response = await request.post(`/auth/echo`).send({
        });
        expect(response).hasStatus(401);
      });

      it('can reject by returning nothing', async function() {
        let response = await request.post(`/auth/returns-nothing`).send({
        });
        expect(response).hasStatus(401);
      });

      it('can search for users', async function() {
        let response = await request.post(`/auth/by-email`).send({
          email: 'quint@example.com'
        });
        expect(response).hasStatus(200);
        expect(response.body).has.deep.property('data.meta.token');
        expect(response.body).has.deep.property('data.id', quint.id);
        response = await request.get('/').set('authorization', `Bearer ${response.body.data.meta.token}`);
        expect(response).hasStatus(200);
        expect(response.body).has.property('userId', quint.id);
        expect(response.body.user).has.deep.property('data.attributes.full-name', "Quint Faulkner");
      });

      it('can provide preloaded user', async function() {
        let response = await request.post(`/auth/echo`).send({
          data: {
            id: 'x',
            type: 'test-users',
            attributes: {
              'full-name': 'Mr X'
            }
          },
          meta: {
            preloaded: true
          }
        });
        expect(response).hasStatus(200);

        // this is exercising the preloadedUser API because this user
        // doesn't exist in the search index, so if Authentication
        // itself tries to do the load it will fail.
        expect(response.body).has.deep.property('data.attributes.full-name', 'Mr X');
      });

      it('applies userTemplate to rewrite ids', async function() {
        let response = await request.post(`/auth/id-rewriter`).send({
          upstreamId: arthur.id
        });
        expect(response).hasStatus(200);
        expect(response.body).has.deep.property('data.id', arthur.id);
        expect(response.body).has.deep.property('data.attributes.full-name', 'Arthur Faulkner');
      });


      it('ignores user update when not configured', async function() {
        let response = await request.post(`/auth/echo`).send({
          data: {
            id: quint.id,
            type: 'test-users',
            attributes: {
              email: 'updated.email@this-changed.com'
            }
          }
        });
        expect(response).hasStatus(200);
        expect(response.body).has.deep.property('data.meta.token');
        expect(response.body).has.deep.property('data.attributes.email', 'quint@example.com');

        await env.lookup('hub:indexers').update({ realTime: true });

        response = await request.get('/').set('authorization', `Bearer ${response.body.data.meta.token}`);
        expect(response).hasStatus(200);
        expect(response.body.userId).equals(quint.id);
        expect(response.body.user).has.property('data');
        expect(response.body.user.data).has.property('id', quint.id);
        expect(response.body.user.data).has.property('type', 'test-users');
        expect(response.body.user.data.attributes).deep.equals({
          'full-name': 'Quint Faulkner',
          email: 'quint@example.com'
        });
      });

      it('when create not configured, returns 401', async function() {
        let response = await request.post(`/auth/echo`).send({
          data: {
            id: 'my-prefix-4321',
            type: 'test-users',
            attributes: {
              'full-name': 'Newly Created',
              email: 'new@example.com'
            }
          }
        });
        expect(response).hasStatus(401);
      });

      it('when plugin returns no type, returns 401', async function() {
        let response = await request.post(`/auth/echo`).send({
          data: {
            id: 'my-prefix-4321',
            attributes: {
              'full-name': 'Newly Created',
              email: 'new@example.com'
            }
          }
        });
        expect(response).hasStatus(401);
      });

      it('can choose to expose some configuration', async function() {
        let response = await request.get('/auth/config-echo-quint');
        expect(response.body).deep.equals({
          data: { id: quint.id, type: 'test-users' }
        });
      });


      it('does not expose config unless opted in', async function() {
        let response = await request.get('/auth/by-email');
        expect(response.body).deep.equals({});
      });

      it(`applies plugin's default template to rewrite ids`, async function() {
        let response = await request.post(`/auth/has-default-template`).send({
          upstreamId: arthur.id
        });
        expect(response).hasStatus(200);
        expect(response.body).has.deep.property('data.id', arthur.id);
        expect(response.body).has.deep.property('data.attributes.full-name', 'Arthur Faulkner');
      });

      it('can return a partial session', async function() {
        let response = await request.post(`/auth/echo`).send({
          data: {
            type: 'test-users',
            attributes: {
              state: 'i-am-partial',
              message: "you're not done yet"
            }
          },
          meta: {
            'partial-session': true
          }
        });
        expect(response).hasStatus(200);
        expect(response.body).not.has.deep.property('meta.token');
        expect(response.body.data).deep.equals({
          type: 'test-users',
          attributes: {
            state: 'i-am-partial',
            message: "you're not done yet"
          }
        });
        expect(response.body.meta).deep.equals({
          'partial-session': true
        });
      });

    });
  });

  describe('(read/write)', function() {
    describe('token issuers', function() {
      beforeEach(setup);
      afterEach(teardown);

      it('can update a user', async function() {
        let response = await request.post(`/auth/update-user`).send({
          data: {
            id: quint.id,
            type: 'test-users',
            attributes: {
              email: 'updated.email@this-changed.com'
            }
          }
        });
        expect(response).hasStatus(200);
        expect(response.body).has.deep.property('data.meta.token');
        expect(response.body).has.deep.property('data.attributes.email', 'updated.email@this-changed.com');

        await env.lookup('hub:indexers').update({ realTime: true });

        response = await request.get('/').set('authorization', `Bearer ${response.body.data.meta.token}`);
        expect(response).hasStatus(200);
        expect(response.body.userId).equals(quint.id);
        expect(response.body.user).has.property('data');
        expect(response.body.user.data).has.property('id', quint.id);
        expect(response.body.user.data).has.property('type', 'test-users');
        expect(response.body.user.data.attributes).deep.equals({
          'full-name': 'Quint Faulkner',
          email: 'updated.email@this-changed.com'
        });
      });

      it('can create a new user', async function() {
        let response = await request.post(`/auth/create-via-template`).send({
          id: '4321',
          firstName: 'Newly',
          lastName: 'Created',
          email: 'new@example.com'
        });
        expect(response).hasStatus(200);
        expect(response.body).has.deep.property('data.meta.token');

        await env.lookup('hub:indexers').update({ realTime: true });

        response = await request.get('/').set('authorization', `Bearer ${response.body.data.meta.token}`);
        expect(response).hasStatus(200);
        expect(response.body.userId).equals('my-prefix-4321');
        expect(response.body.user).has.property('data');
        expect(response.body.user.data).has.property('id', 'my-prefix-4321');
        expect(response.body.user.data).has.property('type', 'test-users');
        expect(response.body.user.data.attributes).deep.equals({
          email: 'new@example.com',
          'full-name': 'Newly Created'
        });
      });

      it('can create a new user with automatic id', async function() {
        let response = await request.post(`/auth/create-via-template-no-id`).send({
          firstName: 'Newly',
          lastName: 'Created',
          email: 'new@example.com'
        });
        expect(response).hasStatus(200);
        expect(response.body).has.deep.property('data.meta.token');
        let autoId = response.body.data.id;

        await env.lookup('hub:indexers').update({ realTime: true });

        response = await request.get('/').set('authorization', `Bearer ${response.body.data.meta.token}`);
        expect(response).hasStatus(200);
        expect(response.body).has.property('user');
        expect(response.body.user.data).has.property('id', autoId);
        expect(response.body.user.data).has.property('type', 'test-users');
        expect(response.body.user.data.attributes).deep.equals({
          email: 'new@example.com',
          'full-name': 'Newly Created'
        });
      });
    });
  });
});
