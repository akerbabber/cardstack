const actions = [
  'may-create-resource',
  'may-read-resource',
  'may-update-resource',
  'may-delete-resource',
  'may-read-field',
  'may-write-field'
];
const logger = require('@cardstack/plugin-utils/logger');
const authLog = logger('auth');

module.exports = class Grant {
  constructor(document) {
    let attrs = document.attributes || {};
    let rels = document.relationships || {};

    for (let action of actions) {
      this[action] = !!attrs[action];
    }

    this.groupId = null;
    this.types = null;
    this.fields = null;
    this.id = document.id;
    if (this.id == null) {
      throw new Error(`grant must have an id: ${JSON.stringify(document)}`);
    }

    if (rels.fields) {
      this.fields = rels.fields.data.map(ref => ref.id);
    }

    if (rels.types) {
      this.types = rels.types.data.map(ref => ref.id);
    }

    if (rels.who) {
      this.groupId = rels.who.data.id;
    }
  }

  async matches(document, context) {
    let user;
    if (context.session) {
      user = await context.session.loadUser();
    }
    let matches = this.groupId == null || (user && this._memberCheck(user, this.groupId));
    authLog.trace('testing grant id=%s groupId=%s document=%j context=%j matches=%s', this.id, this.groupId, document, context, !!matches);
    return matches;
  }

  _memberCheck(user, groupId) {
    return String(user.id) === String(groupId);
  }
};
