import './es_features_spec'
import './jsx_spec'
import './coffee_spec'
import './typescript_spec'
import './tsx_spec'
import json from './json_file'

expect(json).to.eql({ json: 'contents' })
