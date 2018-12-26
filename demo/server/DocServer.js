
const invariant = require('invariant');
const querystring = require('querystring');
const url = require('url');

function assertNumber(val, name) {
  invariant(
    typeof val === 'number' && !isNaN(val),
    name + '(' + String(val) + ') is not a number',
  );
}

function assertNotNull(val, name) {
  invariant(
    val !== null && val !== undefined,
    name + '(' + String(val) + ') is null',
  );
}

function assertObject(val, name) {
  invariant(
    typeof val === 'object' && val !== null,
    name + '(' + String(val) + ') is not an Object',
  );
}

function assertArray(val, name) {
  invariant(
    Array.isArray(val),
    name + '(' + String(val) + ') is not an Array',
  );
}

class DocServer {

  constructor() {
    this.requestCount = 0;
    this.startTime = Date.now();
    this.handleRequest = this.handleRequest.bind(this);
    this.handleGet = this.handleGet.bind(this);
    this.handlePost = this.handlePost.bind(this);
    this.log = this.log.bind(this);
  }

  handleRequest(request, response) {
    this.requestCount++;

    const parsed = url.parse(request.url, true);
    const path = parsed.pathname || '';
    const method = request.method;

    const payload = {
      path: path,
      method: method,
      server: {
        requestCount: this.requestCount,
        requestTime: Date.now(),
        startTime: this.startTime,
      },
    };

    this.log('start');

    if (method.toUpperCase() === 'POST') {
      let body = '';
      request.on('data', function(chunk) {
        body += chunk.toString();
      });
      request.on('end', function() {
        const query = JSON.parse(querystring.parse(body).params);
        payload.params =  toParams(query.params);
        // this.log(JSON.stringify(payload));
        this.handlePost(request, response,  payload);
        this.log('end');
        body = null;
      }.bind(this));
    } else {
      payload.params = toParams(parsed.query);
      this.log(JSON.stringify(payload));
      this.handleGet(request, response,  payload);
      this.log(method + ' end');
    }
  }

  respond(response, payload) {
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    const jsonString = JSON.stringify(payload, null, 2);
    this.log(jsonString);
    response.end(jsonString);
  }

  handleGet(request, response,  payload) {
    throw new Error('not supported');
    const params = payload.params;
    const docId = params.docId;
    const version = params.version;
    assertNumber(docId, 'docId');
    assertNumber(version, 'version');


    let docModel = DocModel.findBy((model) => {
      return model.id === docId;
    });

    if (!docModel) {
      this.log('create doc model for ' + docId);
      docModel = DocModel.create();
      docModel.update({id: docId, version: version});
      DocModel.insert(docModel);
    } else {
      this.log('found doc model for ' + docId);
    }

    assertNotNull(docModel, 'docModel');
    payload.doc = docModel.toJSON();
    this.respond(response, payload);
  }

  handlePost(request, response,  payload) {
    const params = payload.params;
    const steps = params.steps;
    const editorState = params.editorState;
    const version = params.version;
    const docId = params.docId;
    const userId = params.userId;

    assertArray(steps, 'steps');
    assertNumber(docId, 'docId');
    assertNumber(userId , 'userId');
    assertNumber(version, 'version');
    assertObject(editorState, 'editorState');

    let docModel = DocModel.findBy((model) => {
      return model.id === docId;
    });

    if (!docModel) {
      this.log('create doc model for ' + docId);
      docModel = DocModel.create();
      docModel.update({id: docId, version: version, editor_state: editorState});
      DocModel.insert(docModel);
    }

    assertNotNull(docModel, 'docModel');
    invariant(version <=  docModel.version, 'unmatched version ' + version);

    const stepKeys = new Set();
    steps.forEach(step => {
      const stepKey = step.key;
      stepKeys.add(stepKey);
      assertNotNull(stepKey, 'stepKey');
      let stepModel = StepModel.findBy(s => s.key === stepKey);
      if (stepModel === null) {
        this.log('insert step ' + stepKey);
        stepModel = StepModel.create();
        stepModel.update(step);
        stepModel.update({doc_id: docId, version: version, created_by: userId});
        StepModel.insert(stepModel);
      }
    });

    this.log('StepModel.size ' + StepModel.size);

    const newSteps = StepModel.where(stepModel => {
      const stepKey = stepModel.key;
      if (
        stepModel.doc_id === docId &&
        stepModel.version >= version &&
        !stepKeys.has(stepKey)
      ) {
        return true;
      }
      return false;
    });

    if (version < docModel.version && !newSteps) {
      throw new Error('version ' + version + ' is too old');
    }

    if (newSteps.length === 0) {
      docModel.update({
        editor_state: editorState,
        version: docModel.version + 1,
      });
      payload.accepted = true;
      payload.steps = [];
    } else if (docModel.version - version > 50) {
      // too old.
      payload.accepted = false;
      payload.steps = [];
      payload.editorState = docModel.editor_state;
    } else {
      payload.accepted = false;
      payload.steps = newSteps.map(step => step.toJSON()).sort(sortSteps);
    }
    payload.docId = docModel.id;
    payload.version = docModel.version;
    this.respond(response, payload);
  }

  log(msg) {
    console.log('==========================================================\n');
    console.log(msg);
    console.log('==========================================================\n');
  }
};

function defineCollection(ModelClass) {

  const models = [];
  let index = 0;

  const findBy = (predict) => {
    let found = null;
    models.some((model) => {
      if (predict(model)) {
        found = model;
      }
    });
    return found;
  };

  const where = (predict) => {
    return models.reduce((results, model) => {
      if (predict(model)) {
        results.push(model);
      }
      return results;
    }, []);
  };

  const insert = (model) => {
    const id = model.id;
    const predict = (m) => m.id === id;
    invariant(id, 'model id undefined');
    invariant(findBy(predict) === null, 'duplicated model ' + id);
    models.push(model);
    ModelClass.size = models.length;
    return model;
  };

  const create = (payload) => {
    index++;
    const model = new ModelClass(payload || {});
    model.id = index;
    return model;
  };

  ModelClass.create = create;
  ModelClass.findBy = findBy;
  ModelClass.insert = insert;
  ModelClass.where = where;
  ModelClass.size = 0;
}

class Model {
  constructor() {
    this.created_at = Date.now();
    this.updated_at = Date.now();
    this.update = this.update.bind(this);
  }

  update(payload) {
    payload && Object.assign(this, payload);
    this.updated_at = Date.now();
  }
}

class DocModel extends Model {
  constructor(payload) {
    super();
    this.update(payload);
  }
  toJSON() {
    return {
      id: this.id,
      version: this.version,
      editor_state: this.editor_state,
    };
  }
}

defineCollection(DocModel);

class StepModel extends Model {
  constructor(payload) {
    super(payload);
    this.update(payload);
  }
  toJSON() {
    return {
      created_by: this.created_by,
      data: this.data,
      doc_id: this.doc_id,
      id: this.id,
      key: this.key,
      version: this.version,
    };
  }
}

defineCollection(StepModel);


function sortSteps(a, b) {
  if (a.id > b.id) {
    return 1;
  }
  if (a.id < b.id) {
    return  -1;
  }
  return 0;
}

function toParams(params) {
  Object.keys(params).forEach(key => {
    if (key === 'docId' || key === 'version') {
      params[key] = parseInt(params[key], 10);
    }
  });
  return params;
}



// class StepsModel {
//   constructor(payload) {
//     StepsModel.index++;
//     this.id = 'StepsModel_' + String(StepsModel.index);
//     this.steps = payload.steps;
//     this.version = payload.version;
//   }
//   toJSON() {
//     return {
//       id: this.id,
//       version: this.version,
//       steps: this.steps,
//     };
//   }
// }
// StepsModel.index = 0;

module.exports = DocServer;