/**
 * Knowledge reference, part 7: worked examples. Every example is complete,
 * valid RBLang; the unit tests lint each one and fail on any error, so the
 * reference can never teach the model something the linter rejects.
 */

export interface KnowledgeExample {
  title: string;
  /** What the example demonstrates, one or two sentences. */
  teaches: string;
  rblang: string;
}

const HELLO_WORLD = `<?xml version="1.0" encoding="utf-8"?>
<rbl:kb xmlns:rbl="http://rbl.io/schema/RBLang">
  <concept name="Person" type="string"/>
  <concept name="Country" type="string"/>
  <concept name="Language" type="string"/>

  <rel name="speaks" subject="Person" object="Language" plural="true" askable="all">
    <firstForm>Does %S speak %O?</firstForm>
    <secondFormObject>Which languages does %S speak?</secondFormObject>
    <secondFormSubject>Who speaks %O?</secondFormSubject>
  </rel>
  <rel name="lives in" subject="Person" object="Country" askable="secondFormObject">
    <secondFormObject>Which country does %S live in?</secondFormObject>
  </rel>
  <rel name="national language" subject="Country" object="Language" askable="none"/>

  <concinst name="Julio" type="Person"/>
  <concinst name="English" type="Language"/>
  <concinst name="French" type="Language"/>
  <concinst name="England" type="Country"/>
  <concinst name="France" type="Country"/>

  <relinst type="national language" subject="England" object="English" cf="100"/>
  <relinst type="national language" subject="France" object="French" cf="100"/>

  <relinst type="speaks" cf="75" name="Speaks national language of home country"
           alt="{{%S}} lives in {{%COUNTRY}}, whose national language is {{%O}}">
    <condition rel="lives in" subject="%S" object="%COUNTRY" weight="100" behaviour="mandatory"/>
    <condition rel="national language" subject="%COUNTRY" object="%O" weight="100" behaviour="mandatory"/>
  </relinst>
</rbl:kb>`;

const ELIGIBILITY = `<?xml version="1.0" encoding="utf-8"?>
<rbl:kb xmlns:rbl="http://rbl.io/schema/RBLang">
  <concept name="Applicant" type="string"/>
  <concept name="Age" type="number"/>
  <concept name="Date Of Birth" type="date"/>
  <concept name="Eligibility" type="string" behaviour="mutually-exclusive"/>

  <concinst name="Eligible" type="Eligibility"/>
  <concinst name="Not Eligible" type="Eligibility"/>

  <rel name="has date of birth" subject="Applicant" object="Date Of Birth" askable="secondFormObject">
    <secondFormObject>What is %S's date of birth?</secondFormObject>
  </rel>
  <rel name="has age" subject="Applicant" object="Age" askable="none"/>
  <rel name="has eligibility" subject="Applicant" object="Eligibility" askable="none"/>

  <relinst type="has age" cf="100" name="Derive age from date of birth">
    <condition rel="has date of birth" subject="%S" object="%DOB" weight="100"/>
    <condition expression="yearsBetween(%DOB, today())" value="%O" weight="100"/>
  </relinst>

  <relinst type="has eligibility" object="Eligible" cf="100" name="Adults are eligible"
           alt="{{%S}} is {{%AGE}}, which meets the minimum age of 18">
    <condition rel="has age" subject="%S" object="%AGE" weight="100"/>
    <condition expression="%AGE is greater than or equal to 18" weight="100"/>
  </relinst>

  <relinst type="has eligibility" object="Not Eligible" cf="100" name="Minors are not eligible"
           alt="{{%S}} is {{%AGE}}, under the minimum age of 18">
    <condition rel="has age" subject="%S" object="%AGE" weight="100"/>
    <condition expression="%AGE is less than 18" weight="100"/>
  </relinst>
</rbl:kb>`;

const RISK_SCORING = `<?xml version="1.0" encoding="utf-8"?>
<rbl:kb xmlns:rbl="http://rbl.io/schema/RBLang">
  <concept name="Customer" type="string"/>
  <concept name="Country" type="string"/>
  <concept name="Amount" type="number"/>
  <concept name="Yes No" type="string" behaviour="mutually-exclusive"/>
  <concept name="Risk Level" type="string"/>

  <concinst name="Yes" type="Yes No"/>
  <concinst name="No" type="Yes No"/>
  <concinst name="High" type="Risk Level"/>
  <concinst name="Low" type="Risk Level"/>
  <concinst name="Freedonia" type="Country"/>
  <concinst name="Sylvania" type="Country"/>

  <rel name="is resident in" subject="Customer" object="Country" askable="secondFormObject" group="Customer profile">
    <secondFormObject>Which country is %S resident in?</secondFormObject>
  </rel>
  <rel name="has annual transaction volume" subject="Customer" object="Amount" askable="secondFormObject" group="Customer profile">
    <secondFormObject>What is %S's annual transaction volume?</secondFormObject>
  </rel>
  <rel name="is politically exposed" subject="Customer" object="Yes No" askable="secondFormObject" allowUnknown="true" group="Customer profile">
    <secondFormObject>Is %S a politically exposed person?</secondFormObject>
  </rel>
  <rel name="is high risk jurisdiction" subject="Country" object="Yes No" askable="none"/>
  <rel name="has risk level" subject="Customer" object="Risk Level" askable="none"/>

  <relinst type="is high risk jurisdiction" subject="Freedonia" object="Yes" cf="100"/>
  <relinst type="is high risk jurisdiction" subject="Sylvania" object="No" cf="100"/>

  <!-- Weighted evidence: the jurisdiction is mandatory, the other two raise the score when present. -->
  <relinst type="has risk level" object="High" cf="90" minimum-rule-certainty="40" name="High risk customer"
           alt="{{%S}} is resident in {{%COUNTRY}}, a high-risk jurisdiction">
    <condition rel="is resident in" subject="%S" object="%COUNTRY" weight="0"/>
    <condition rel="is high risk jurisdiction" subject="%COUNTRY" object="Yes" weight="50" behaviour="mandatory"/>
    <condition rel="has annual transaction volume" subject="%S" object="%VOLUME" weight="0" behaviour="optional"/>
    <condition expression="%VOLUME is greater than 250000" weight="30" behaviour="optional"/>
    <condition rel="is politically exposed" subject="%S" object="Yes" weight="20" behaviour="optional"/>
  </relinst>

  <relinst type="has risk level" object="Low" cf="100" name="Low risk customer"
           alt="{{%S}} is resident in {{%COUNTRY}}, which is not a high-risk jurisdiction">
    <condition rel="is resident in" subject="%S" object="%COUNTRY" weight="100"/>
    <condition rel="is high risk jurisdiction" subject="%COUNTRY" object="No" weight="100"/>
  </relinst>
</rbl:kb>`;

const DATASOURCE = `<?xml version="1.0" encoding="utf-8"?>
<rbl:kb xmlns:rbl="http://rbl.io/schema/RBLang">
  <concept name="Person" type="string"/>
  <concept name="Vehicle" type="string">
    <datasource hostname="https://vehicles.example.com" path="/api/lookup?reg={{%S}}&amp;owner={{%OWNER}}" method="GET" name="Vehicle registry">
      <action map="has make=/Response/Vehicle/Make"/>
      <action map="has mileage=/Response/Vehicle/Mileage"/>
      <input rel="owns" subject="%OWNER" object="%S"/>
      <headers>
        <header key="x-api-key" value="YOUR_API_KEY"/>
      </headers>
    </datasource>
  </concept>
  <concept name="Make" type="string"/>
  <concept name="Mileage" type="number"/>
  <concept name="Yes No" type="string" behaviour="mutually-exclusive"/>

  <concinst name="Yes" type="Yes No"/>
  <concinst name="No" type="Yes No"/>

  <rel name="owns" subject="Person" object="Vehicle" plural="true" askable="secondFormObject">
    <secondFormObject>Which vehicles does %S own?</secondFormObject>
  </rel>
  <rel name="has make" subject="Vehicle" object="Make" askable="none"/>
  <rel name="has mileage" subject="Vehicle" object="Mileage" askable="none"/>
  <rel name="is high mileage" subject="Vehicle" object="Yes No" askable="none"/>

  <relinst type="is high mileage" object="Yes" cf="100" name="Over 100k miles">
    <condition rel="has mileage" subject="%S" object="%MILES" weight="100"/>
    <condition expression="%MILES is greater than 100000" weight="100"/>
  </relinst>
  <relinst type="is high mileage" object="No" cf="100" name="Under 100k miles">
    <condition rel="has mileage" subject="%S" object="%MILES" weight="100"/>
    <condition expression="%MILES is less than or equal to 100000" weight="100"/>
  </relinst>
</rbl:kb>`;

const TOP_DOWN = `<?xml version="1.0" encoding="utf-8"?>
<rbl:kb xmlns:rbl="http://rbl.io/schema/RBLang">
  <concept name="Claim" type="string"/>
  <concept name="Claim Type" type="string"/>
  <concept name="Amount" type="number"/>
  <concept name="Text" type="string"/>
  <concept name="Decision" type="string" behaviour="mutually-exclusive"/>

  <concinst name="Motor" type="Claim Type"/>
  <concinst name="Property" type="Claim Type"/>
  <concinst name="Fast Track" type="Decision"/>
  <concinst name="Manual Review" type="Decision"/>

  <rel name="has claim type" subject="Claim" object="Claim Type" askable="secondFormObject">
    <secondFormObject>What type of claim is %S?</secondFormObject>
  </rel>
  <rel name="has amount" subject="Claim" object="Amount" askable="secondFormObject">
    <secondFormObject>What is the amount claimed for %S?</secondFormObject>
  </rel>
  <rel name="has description" subject="Claim" object="Text" askable="secondFormObject">
    <secondFormObject>Describe what happened for %S.</secondFormObject>
  </rel>
  <rel name="has decision" subject="Claim" object="Decision" askable="none"/>

  <!-- Strict ordering: the cheap knock-out tests run first; the free-text question is only asked if they pass. -->
  <relinst type="has decision" object="Fast Track" cf="100" behaviour="top-down-strict" name="Fast track small motor claims"
           alt="{{%S}} is a {{%TYPE}} claim for {{%AMOUNT}} with no fraud indicators">
    <condition rel="has claim type" subject="%S" object="%TYPE" weight="100"/>
    <condition expression="%TYPE is equal to 'Motor'" weight="100"/>
    <condition rel="has amount" subject="%S" object="%AMOUNT" weight="100"/>
    <condition expression="%AMOUNT is less than or equal to 2500" weight="100"/>
    <condition rel="has description" subject="%S" object="%TEXT" weight="100"/>
    <condition expression="regexCount(%TEXT, '/theft|fire|third party/i') is equal to 0" weight="100"/>
  </relinst>

  <relinst type="has decision" object="Manual Review" cf="100" name="Large claims need review">
    <condition rel="has amount" subject="%S" object="%AMOUNT" weight="100"/>
    <condition expression="%AMOUNT is greater than 2500" weight="100"/>
  </relinst>
</rbl:kb>`;

const AGGREGATION = `<?xml version="1.0" encoding="utf-8"?>
<rbl:kb xmlns:rbl="http://rbl.io/schema/RBLang">
  <concept name="Student" type="string"/>
  <concept name="Score" type="number"/>
  <concept name="Average" type="number"/>
  <concept name="Has Data" type="truth"/>

  <rel name="has score" subject="Student" object="Score" plural="true" askable="secondFormObject">
    <secondFormObject>What scores has %S achieved?</secondFormObject>
  </rel>
  <rel name="has average score" subject="Student" object="Average" askable="none"/>
  <rel name="has complete data" subject="Student" object="Has Data" askable="none"/>

  <relinst type="has average score" cf="100" name="Average of all scores">
    <condition expression="countRelationshipInstances(%S, 'has score', *)" value="%COUNT" weight="100"/>
    <condition expression="%COUNT is greater than 0" weight="100"/>
    <condition expression="sumObjects(%S, 'has score', *)" value="%SUM" weight="100"/>
    <condition expression="round(%SUM / %COUNT, 1)" value="%O" weight="100"/>
  </relinst>

  <relinst type="has complete data" object="false" cf="100" name="No scores recorded">
    <condition expression="countRelationshipInstances(%S, 'has score', *) is equal to 0" weight="100"/>
  </relinst>
  <relinst type="has complete data" object="true" cf="100" name="Scores recorded">
    <condition expression="countRelationshipInstances(%S, 'has score', *) is greater than 0" weight="100"/>
  </relinst>
</rbl:kb>`;

export const KNOWLEDGE_EXAMPLES: KnowledgeExample[] = [
  {
    title: "Hello World — chaining two relationships",
    teaches: "Three concepts, askable relationships with all three question forms, facts, and one rule that binds an intermediate variable (%COUNTRY) to chain 'lives in' into 'national language'. cf 75 marks the rule as a heuristic.",
    rblang: HELLO_WORLD,
  },
  {
    title: "Eligibility — derived value and mutually-exclusive outcome",
    teaches: "A derived number (age) computed with value=\"%O\" from a date, an askable=\"none\" relationship for it, and one rule per outcome instance of a mutually-exclusive concept, each with evidence text.",
    rblang: ELIGIBILITY,
  },
  {
    title: "Risk scoring — weights, optional conditions and a certainty floor",
    teaches: "A mandatory knock-in condition plus optional weighted evidence; weight=\"0\" on binding conditions so only the tests carry salience; cf 90 as ceiling and minimum-rule-certainty 40 as cut-off; allowUnknown and question grouping.",
    rblang: RISK_SCORING,
  },
  {
    title: "Datasource — facts fetched from a REST API",
    teaches: "A GET datasource on the subject concept (Vehicle) with {{%S}} and an <input>-bound variable in the path, headers, and actions mapping response paths onto relationships whose subject is Vehicle. Note &amp; in the path attribute.",
    rblang: DATASOURCE,
  },
  {
    title: "Top-down-strict — gating an intrusive question behind cheap tests",
    teaches: "behaviour=\"top-down-strict\" so the free-text question is only asked after the type and amount checks pass; regexCount for text classification; a second rule covering the other outcome.",
    rblang: TOP_DOWN,
  },
  {
    title: "Aggregation — list functions over a plural relationship",
    teaches: "countRelationshipInstances and sumObjects bound to variables, a guard against division by zero, round(), and the absence idiom (count is equal to 0) with a truth-typed object.",
    rblang: AGGREGATION,
  },
];

export function buildExamplesSection(): string {
  const blocks = KNOWLEDGE_EXAMPLES.map(
    (e) => `### ${e.title}\n\n${e.teaches}\n\n\`\`\`rblang\n${e.rblang}\n\`\`\``
  );
  return `## 19. Worked examples\n\nEach example is complete and passes the linter.\n\n${blocks.join("\n\n")}`;
}
