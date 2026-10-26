// Proposed pilot weights. Approval is always a separate human action.
// A group's weight is split explicitly, never normalized at runtime.
export const mappings={
 'software-development-engineer':{'SW-01':15,'SW-03':15,'SW-02':20,'GEN-04':15,'GEN-05':10,'SW-04':8,'SW-05':7,'GEN-07':10},
 'machine-learning-engineer':{'AI-04':15,'AI-05':15,'AI-01':15,'AI-03':10,'GEN-04':25,'AI-09':10,'GEN-07':10},
 'mechanical-design-engineer':{'MEC-01':15,'MEC-02':15,'MEC-07':15,'GEN-03':10,'MEC-03':25,'MEC-05':10,'GEN-06':10},
 'digital-marketing-executive':{'MKT-03':30,'MKT-08':25,'MKT-04':10,'MKT-05':10,'MKT-01':8,'MKT-02':7,'GEN-07':10},
 'sales-development-representative':{'SAL-02':30,'SAL-05':15,'SAL-06':10,'SAL-03':20,'SAL-07':8,'SAL-08':7,'SAL-10':10},
 'backend-developer':{'SW-06':30,'SW-07':20,'SW-01':15,'SW-04':15,'SW-15':10,'GEN-06':10},
 'frontend-developer':{'SW-13':30,'SW-01':20,'SW-04':15,'SW-10':15,'SW-12':10,'GEN-07':10},
 'data-analyst':{'AI-12':30,'AI-11':25,'AI-03':20,'AI-13':15,'GEN-07':10},
 'cybersecurity-analyst':{'INF-10':25,'INF-12':25,'INF-13':20,'INF-14':20,'GEN-06':10},
 'devops-engineer':{'INF-03':20,'INF-06':20,'INF-07':20,'INF-04':15,'INF-08':15,'GEN-06':10},
 'embedded-software-engineer':{'ECE-03':30,'ECE-04':25,'ECE-05':20,'ECE-12':15,'GEN-06':10},
 'vlsi-design-engineer':{'ECE-07':35,'ECE-06':25,'ECE-08':20,'ECE-12':10,'GEN-06':10},
 'structural-engineer':{'CIV-01':30,'CIV-04':25,'CIV-02':20,'CIV-09':15,'CIV-10':10},
 'business-analyst':{'BUS-04':30,'BUS-08':25,'BUS-05':20,'BUS-09':15,'GEN-07':10},
 'financial-analyst':{'BUS-01':30,'BUS-02':25,'BUS-03':25,'BUS-18':10,'GEN-07':10},
 'ui-ux-designer':{'BUS-13':25,'MKT-02':20,'MKT-12':25,'GEN-04':20,'GEN-07':10},
};
export const fixtureGroups=[
 ['software',20,'software-development-engineer'],['ai-data',15,'machine-learning-engineer'],
 ['infrastructure-security',10,'devops-engineer'],['mechanical',15,'mechanical-design-engineer'],
 ['electronics',10,'embedded-software-engineer'],['marketing',10,'digital-marketing-executive'],
 ['sales',10,'sales-development-representative'],['business',10,'business-analyst'],
];
